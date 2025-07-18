// external dependencies
const EventEmitter = require('events').EventEmitter
const protoo = require('protoo-server')


class Room extends EventEmitter {
  static async create({ mediasoupWorker }) {
    const room = new protoo.Room()
    const { mediaCodecs } = getRouterOptions()
    const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs })
    
    return new Room({ room, mediasoupRouter })
  }

  constructor({ room, mediasoupRouter }) {
    super()
    this.setMaxListeners(Infinity)

    this.closed = false
    this.room = room
    this.mediasoupRouter = mediasoupRouter
    this.broadcasters = new Map()
  }

  close() {
    this.closed = true
    this.room.close()
    this.mediasoupRouter.close()
    this.emit('close')
  }

  handleProtooConnection({ peerId, consume, protooWebSocketTransport }) {
    // check if the peerId is already connected
    if (peerId.startsWith('robot-')) {
        const existingRobot = this.room.peers.find(peer => peer.id.startsWith('robot-'))
        if (existingRobot) {
            throw new Error('Robot already connected')
        }
    } else if (peerId.startsWith('client-')) {
        const existingClient = this.room.getPeer(peerId)
        if (existingClient) {
            throw new Error('Client already connected')
        }
    }

    // create the peer
    let peer

    try {
      peer = this.room.createPeer(peerId, protooWebSocketTransport)
    } catch (error) {
        throw new Error('Failed to create peer')
    }

    // set the peer data
    peer.data.consume = consume
    peer.data.joined = false
    peer.data.rtpCapabilities = undefined
    peer.data.sctpCapabilities = undefined

    peer.data.transports = new Map()
    peer.data.producers = new Map()
    peer.data.consumers = new Map()

    // handle requests
    peer.on('request', (request, accept, reject) => {
      this.handleRequest(peer, request, accept, reject).catch((error) => {
        reject(error)
      })
    })

    // handle close
    peer.on('close', () => {
      if (this.closed) {
        return
      }

      console.log("[%s] Peer closed", peer.id)

      if (peer.id.startsWith('robot-')) {
        this.close()
      }

      if (peer.data.joined) {
        for (const otherPeer of this.getJoinedPeers({ excludePeer: peer })) {
          otherPeer.notify('peerClosed', { peerId: peer.id }).catch(() => {})
        }
      }

      for (const transport of peer.data.transports.values()) {
        transport.close()
      }
    })
  }

  getJoinedPeers({ excludePeer = undefined } = {}) {
    return this.room.peers.filter((peer) => peer.data.joined && peer !== excludePeer)
  }

  async handleRequest(peer, request, accept, reject) {
    switch (request.method) {
      case 'getRouterRtpCapabilities': {
        accept(this.mediasoupRouter.rtpCapabilities)
        break
      }

      case 'join': {
        if (peer.data.joined) {
          throw new Error('Peer already joined')
        }

        const { rtpCapabilities, sctpCapabilities } = request.data

        peer.data.joined = true
        peer.data.rtpCapabilities = rtpCapabilities
        peer.data.sctpCapabilities = sctpCapabilities

        // tell the new peer about already joined peers
        // and also create consumers for existing producers
        const joinedPeers = [
          ...this.getJoinedPeers(),
          ...this.broadcasters.values(),
        ]

        // reply now the request with the list of joined peers (all but the new one)
        const peerInfos = joinedPeers
          .filter((joinedPeer) => joinedPeer.id !== peer.id)
          .map((joinedPeer) => ({ id: joinedPeer.id }))

        accept({ peers: peerInfos })

        // mark the new peer as joined
        peer.data.joined = true

        for (const joinedPeer of joinedPeers) {
          // create consumers for existing producers
          for (const producer of joinedPeer.data.producers.values()) {
            this.createConsumer({
              consumerPeer: peer,
              producerPeer: joinedPeer,
              producer,
            })
          }
        }

        // notify the new peer to all other peers
        for (const otherPeer of this.getJoinedPeers({ excludePeer: peer })) {
          otherPeer.notify('newPeer', { id: peer.id })
            .catch(() => {});
        }

        console.log("[%s] Peer joined", peer.id)
        break;
      }

      case 'createWebRtcTransport': {
        // NOTE: don't require that the peer is joined here, so the client can
        // initiate mediasoup transports and be ready when he later joins
        const {
          producing,
          consuming,
          sctpCapabilities
        } = request.data

        const webRtcTransportOptions = {
          listenIps: [
            {
              ip: '10.2.0.4',
              announcedIp: '20.153.160.2'
            }
          ],
          initialAvailableOutgoingBitrate: 1000000,
          minimumAvailableOutgoingBitrate: 600000,
          maxSctpMessageSize: 262144,
          enableSctp     : Boolean(sctpCapabilities),
          numSctpStreams : (sctpCapabilities || {}).numStreams,
          appData        : { producing, consuming },
        }

          const transport = await this.mediasoupRouter.createWebRtcTransport(webRtcTransportOptions)

        transport.on('sctpstatechange', (sctpState) => {
        //   console.debug('WebRtcTransport "sctpstatechange" event [sctpState:%s]', sctpState)
        })

        transport.on('dtlsstatechange', (dtlsState) => {
          if (dtlsState === 'failed' || dtlsState === 'closed') {
            // console.warn('WebRtcTransport "dtlsstatechange" event [dtlsState:%s]', dtlsState)
          }
        })

        // store the web rtc transport into the protoo peer data object
        peer.data.transports.set(transport.id, transport)

        accept({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          sctpParameters: transport.sctpParameters,
        })
        break
      }

      case 'connectWebRtcTransport': {
        const { transportId, dtlsParameters } = request.data
        const transport = peer.data.transports.get(transportId)
        if (!transport) {
          throw new Error(`transport with id "${transportId}" not found`)
        }
        await transport.connect({ dtlsParameters })
        accept()
        break
      }

      case 'restartIce': {
        const { transportId } = request.data
        const transport = peer.data.transports.get(transportId)
        if (!transport) {
          throw new Error(`transport with id "${transportId}" not found`)
        }
        const iceParameters = await transport.restartIce()
        accept(iceParameters)
        break
      }

      case 'produce': {
        // ensure the peer is joined
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { transportId, kind, rtpParameters } = request.data
        let { appData } = request.data
        const transport = peer.data.transports.get(transportId)

        if (!transport) {
          throw new Error(`transport with id "${transportId}" not found`)
        }

        // add peerId into appData to later get the associated peer during
        // the 'loudest' event of the audioLevelObserver
        appData = { ...appData, peerId: peer.id }

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData,
        })

        // store the producer into the protoo peer data object
        peer.data.producers.set(producer.id, producer)

        accept({ id: producer.id })

        // optimization: create a server-side consumer for each peer
        if (!peer.id.startsWith('robot-')) {
          this.createConsumer({
            consumerPeer : peer,
            producerPeer : this.room.peers.find(peer => peer.id.startsWith('robot-')),
            producer,
          })
        }
        break
      }

      case 'closeProducer': {
        // ensure the peer is joined
        if (!peer.data.joined) {
          throw new Error('Peer not yet joined')
        }

        const { producerId } = request.data
        const producer = peer.data.producers.get(producerId)

        if (!producer) {
          throw new Error(`producer with id "${producerId}" not found`)
        }

        producer.close()

        // remove from its map
        peer.data.producers.delete(producer.id)

        accept()

        break
      }
    }
  }

  async createConsumer({ consumerPeer, producerPeer, producer }) {

    // must take the transport the remote peer is using for consuming
    const transport = Array.from(consumerPeer.data.transports.values())
      .find((t) => t.appData.consuming)

    if (!transport) {
      console.warn('createConsumer() | Transport for consuming not found')
      return
    }

    let consumer

    try {
      consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: consumerPeer.data.rtpCapabilities,
        paused: false
      })
    } catch (error) {
      console.warn('createConsumer() | transport.consume():%o', error)
      return
    }

    consumerPeer.data.consumers.set(consumer.id, consumer)
    consumer.on('transportclose', () => {
      consumerPeer.data.consumers.delete(consumer.id)
    })

    consumer.on('producerclose', () => {
      consumerPeer.data.consumers.delete(consumer.id)
      consumerPeer.notify('consumerClosed', { consumerId: consumer.id }).catch(() => {})
    })

    try {
      await consumerPeer.request('newConsumer', {
        peerId: producerPeer.id,
        producerId: producer.id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        appData: producer.appData,
      })
    } catch (error) {
      console.warn('createConsumer() | failed:%o', error)
    }
  }
}

function getRouterOptions() {
  return {
    mediaCodecs: [{
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: {
          'profile-id': 2,
          'x-google-start-bitrate': 1000,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000,
        },
      },
    ],
  }
}

// export the Room class
module.exports = Room