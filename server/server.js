// external dependencies
const http = require('http')

const express = require('express')
const mediasoup = require('mediasoup')
const protoo = require('protoo-server')

// local dependencies
const Room = require('./room')

// global variables
let httpServer
let appServer
let socketServer
let mediasoupWorker
let rooms = new Map()


async function run() {
  await runMediasoupWorker()
  await createAppServer()
  await runHttpServer()
  await runSocketServer()
}

async function runMediasoupWorker() {
  // create a mediasoup worker
  console.info('Running media soup worker')
  mediasoupWorker = await mediasoup.createWorker({
    logLevel: 'warn',
    logTags: [
      'info',
      'ice',
      'dtls',
      'rtp',
      'srtp',
      'rtcp',
      'rtx',
      'bwe',
      'score',
      'simulcast',
      'svc',
      'sctp'
    ],
    rtcMinPort : 40000,
    rtcMaxPort : 49999,
  })

  // handle mediasoup worker death
  mediasoupWorker.on('died', () => {
    console.error(
      'Mediasoup worker died, exiting in 2 seconds [pid:%d]', worker.pid
    )
    setTimeout(() => process.exit(1), 2000)
  })
}

async function createAppServer() {
  // create an express server
  console.info('Running app server')
  appServer = express()
  appServer.use(express.json())
}

async function runHttpServer() {
  // create an http server
  console.info('Running http server')
  httpServer = http.createServer(appServer)
  await new Promise((resolve) => {
    httpServer.listen(8000, '10.2.0.4', resolve)
  })
}

async function runSocketServer() {
  // create a web socket server
  console.info('Running web socket server')

  socketServer = new protoo.WebSocketServer(httpServer, {
    maxReceivedFrameSize     : 960000,
    maxReceivedMessageSize   : 960000,
    fragmentOutgoingMessages : true,
    fragmentationThreshold   : 960000
  })

  // handle connection requests
  socketServer.on('connectionrequest', async (info, accept, reject) => {
    const url = new URL(info.request.url, info.request.headers.origin)
    const roomId = url.searchParams.get('roomId')
    const peerId  = url.searchParams.get('peerId')

    // check if the peerId is provided
    if (!peerId) {
      reject(400, 'Connection request without peerId')
      return
    }

    // check if the roomId is provided
    if (!roomId) {
      reject(400, 'Connection request without roomId')
      return
    }

    if (rooms.has(roomId)) {
      room = rooms.get(roomId)
    } else {
      room = await Room.create({ mediasoupWorker })
      room.on('close', () => {
        console.warn('[%s] Room closed', roomId)
        rooms.delete(roomId)
      })
      rooms.set(roomId, room)
      console.info('[%s] Room created', roomId)
    }

    // handle the connection request
    try {
      rooms.get(roomId).handleProtooConnection({ peerId, consume: true, protooWebSocketTransport: accept() })
    } catch (error) {
      console.error('Room creation or room joining failed: %o', error)
      reject()
    }
  })
}

// run the server
run()