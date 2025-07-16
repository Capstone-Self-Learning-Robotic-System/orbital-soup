import protooClient from 'protoo-client'
import * as mediasoupClient from 'mediasoup-client'
import { random } from 'lodash'

let mediasoupDevice = null
let recvTransport = null
let closed = false
let protoo = null
let consumers = new Map()

let peers = {}

join()

function closeConnections() {
  if (closed) {
    return
  }

  closed = true
  console.debug('close()')

  protoo.close()

  if (sendTransport) {
    sendTransport.close()
  }

  if (recvTransport) {
    recvTransport.close()
  }
}

async function join() {
  const randomPeerId = random(1, 1000000)
  const roomId = 1
  const protooUrl = 'ws://localhost:8000?peerId=client-' + randomPeerId + '&roomId=' + roomId
  console.debug("PeerId %i, RoomId %i", randomPeerId, roomId)
  const protooTransport = new protooClient.WebSocketTransport(protooUrl)
  protoo = new protooClient.Peer(protooTransport)

  protoo.on('open', () => _joinRoom())

  protoo.on('failed', () => {
    console.error('failed websocket')
  })

  protoo.on('disconnected', () => {
    console.error('disconnected')

    if (recvTransport) {
      recvTransport.close()
      recvTransport = null
    }
  })

  protoo.on('close', () => {
    if (this._closed) {
      return;
    }
    this.close()
  })

  protoo.on('request', async (request, accept, reject) => {
    console.debug('proto "request" event [method:%s, data:%o]', request.method, request.data)
    switch (request.method) {
      case 'newConsumer': {
        const {
          peerId,
          producerId,
          id,
          kind,
          rtpParameters,
          appData,
        } = request.data

        try {
          const consumer = await recvTransport.consume({
            id,
            producerId,
            kind,
            rtpParameters,
            appData : { ...appData, peerId },
          })

          consumers.set(consumer.id, consumer)

          if (kind === "video") {
            // let video = document.createElement('video')
            let video = document.getElementById('other-video')
            video.srcObject = new MediaStream([consumer._track])
            video.playsInline = true
            // video.width = 640
            // video.height = 480
            video.autoplay = true
            // document.getElementById('other-video')
          }

          consumer.on('transportclose', () => {
            consumers.delete(consumer.id)
          })
          accept()
        } catch (error) {
          console.error('"newConsumer" request failed:%o', error)
          throw error
        }
        break
      }
    }
  })

  protoo.on('notification', (notification) => {
    console.debug('proto "notification" event [method:%s, data:%o]', notification.method, notification.data)

    switch (notification.method) {
      case 'newPeer': {
        const peer = notification.data
        peers[peer.id] = { ...peer,  consumers: [] }
        break
      }

      case 'peerClosed': {
        const { peerId } = notification.data
        delete peers[peerId]
        break
      }

      case 'consumerClosed': {
        const { consumerId } = notification.data
        const consumer = consumers.get(consumerId)

        if (!consumer) {
          break
        }

        consumer.close()
        consumers.delete(consumerId)

        const { peerId } = consumer.appData

        peers[peerId].consumers = peers[peerId].consumers.filter(e => e !== consumerId)
        break
      }

      default: {
        console.error('unknown protoo notification.method "%s"', notification.method)
      }
    }
  })
}

async function _joinRoom() {
  console.debug('_joinRoom()')

  try {
    mediasoupDevice = new mediasoupClient.Device()
    const routerRtpCapabilities = await protoo.request('getRouterRtpCapabilities')
    await mediasoupDevice.load({ routerRtpCapabilities })

    let transportInfo = await protoo.request('createWebRtcTransport', {
      producing: false,
      consuming: true,
      sctpCapabilities: false,
    })

    recvTransport = mediasoupDevice.createRecvTransport({
      id: transportInfo.id,
      iceParameters: transportInfo.iceParameters,
      iceCandidates: transportInfo.iceCandidates,
      dtlsParameters: transportInfo.dtlsParameters,
      sctpParameters: transportInfo.sctpCapabilities,
      iceServers : [],
    })

    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      protoo.request('connectWebRtcTransport', {
        transportId: recvTransport.id,
        dtlsParameters,
      })
      .then(callback)
      .catch(errback)
    })

    const { peers } = await protoo.request('join', {
      rtpCapabilities : mediasoupDevice.rtpCapabilities
    })

    for (const peer of peers) {
      peers[peer.id] = {...peer, consumers: []}
    }

  } catch (error) {
    console.error('_joinRoom() failed:%o', error)
    closeConnections()
  }
}