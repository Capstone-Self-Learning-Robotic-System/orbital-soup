// external dependencies
const https = require('https')

const express = require('express')
const mediasoup = require('mediasoup')
const protoo = require('protoo-server')
const fs = require('fs')

const key = fs.readFileSync('/home/orbital-user/orbital-soup/server/privkey.pem', 'utf-8');
const cert = fs.readFileSync('/home/orbital-user/orbital-soup/server/fullchain.pem', 'utf-8');

// local dependencies
const Room = require('./room')

// global variables
let httpsServer
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
  // console.info('Running media soup worker')
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
    rtcMinPort : 4000,
    rtcMaxPort : 4999,
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
  // console.info('Running app server')
  appServer = express()
  appServer.use(express.json())
}

async function runHttpServer() {
  // create an http server
  // console.info('Running https server')

  httpsServer = https.createServer({ key, cert }, appServer)
  await new Promise((resolve) => {
    httpsServer.listen(8000, '10.2.0.4', resolve)
  })
}

async function runSocketServer() {

  // roomId to create
  const createRoomId = process.argv[2]

  // create room
  const room = await Room.create({ mediasoupWorker })
  room.on('close', () => {
    console.warn('[%s] Room closed', createRoomId)
    rooms.delete(createRoomId)
  })
  rooms.set(createRoomId, room)
  console.info('[%s] Room created', createRoomId)

  // create a web socket server
  // console.info('Running web socket server')

  socketServer = new protoo.WebSocketServer(httpsServer, {
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

    // check if the room exists
    if (!rooms.has(roomId)) {
      reject(400, 'Room not found')
      return
    }

    // handle the connection request
    try {
      rooms.get(roomId).handleProtooConnection({ peerId, consume: true, protooWebSocketTransport: accept() })
    } catch (error) {
      console.error('Room joining failed: %o', error)
      reject()
    }
  })
}

// run the server
run()