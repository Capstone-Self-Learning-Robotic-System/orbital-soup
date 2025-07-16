import sys
import json
import asyncio
import argparse
import secrets
from typing import Optional, Dict, Awaitable, Any, TypeVar
from asyncio.futures import Future
import cv2
import datetime
import fractions
import numpy as np

from pymediasoup import Device
from pymediasoup import AiortcHandler
from pymediasoup.transport import Transport
from pymediasoup.consumer import Consumer
from pymediasoup.producer import Producer
from pymediasoup.data_consumer import DataConsumer
from pymediasoup.data_producer import DataProducer
from pymediasoup.sctp_parameters import SctpStreamParameters

# Import aiortc
from aiortc import VideoStreamTrack
from aiortc.mediastreams import AudioStreamTrack
from aiortc.contrib.media import MediaPlayer, MediaBlackhole, MediaRecorder
from av import VideoFrame

# Implement simple protoo client
import websockets
from random import random

T = TypeVar("T")


# custom video stream track for camera streaming
class CameraStreamTrack(VideoStreamTrack):
    def __init__(self, camera_id, put_timestamp=False):
        super().__init__()

        # set up camera
        self.cap = cv2.VideoCapture(camera_id)
        # self.cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc('M', 'J', 'P', 'G'))

        self.fps = int(self.cap.get(cv2.CAP_PROP_FPS))
        print("Framerate:", str(self.fps))

        # initialize frame count
        self.frame_count = 0

        # put timestamp
        self.put_timestamp = put_timestamp

    async def recv(self):
        self.frame_count += 1

        ret, frame = self.cap.read()
        if not ret:
            print("Failed to read frame from camera")
            return None
        
        # add timestamp if desired
        if self.put_timestamp:
            timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            cv2.putText(frame, timestamp, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2, cv2.LINE_AA)

        # format video frame
        frame = np.asarray(frame, dtype=np.uint8)
        video_frame = VideoFrame.from_ndarray(frame, format="bgr24")
        video_frame.pts = self.frame_count
        video_frame.time_base = fractions.Fraction(1, self.fps)

        return video_frame


class RobotClient:
    def __init__(self, uri, video_track):
        self.uri = uri

        self.websocket = None
        self.device = None

        self.tracks = []

        self.video_track = video_track

        self.send_transport = None
        self.producers = []

        self.tasks = []
        self.closed = False

    # websocket receive task
    async def recv_msg_task(self):
        while True:
            await asyncio.sleep(0.5)
            if self.websocket is not None:
                message = json.loads(await self.websocket.recv())
                
                if message.get("open"):
                    print("open")
                
                elif message.get("failed"):
                    print("failed")

                elif message.get("disconnected"):
                    print("disconnected")

                elif message.get("close"):
                    print("close")

    # Generates a random positive integer.
    def generate_random_number(self) -> int:
        return round(random() * 10000000)

    async def run(self):
        self.websocket = await websockets.connect(origin="http://localhost:8000", uri=self.uri, subprotocols=["protoo"])
        await self.load()
        await self.create_send_transport()
        await self.produce()

        while not self.closed:
            await asyncio.sleep(0.1)

    async def load(self):
        # Init device
        self.device = Device(
            handlerFactory=AiortcHandler.createFactory(tracks=[self.video_track])
        )

        # Get Router RtpCapabilities
        reqId = self.generate_random_number()
        req = {
            "request": True,
            "id": reqId,
            "method": "getRouterRtpCapabilities",
            "data": {},
        }
        await self.websocket.send(json.dumps(req))
        ans = json.loads(await self.websocket.recv())

        # Load Router RtpCapabilities
        await self.device.load(ans["data"])

    async def create_send_transport(self):
        
        if self.send_transport is not None:
            return
        
        # Send create send_transport request
        reqId = self.generate_random_number()
        req = {
            "request": True,
            "id": reqId,
            "method": "createWebRtcTransport",
            "data": {
                "forceTcp": False,
                "producing": True,
                "consuming": False,
                "sctpCapabilities": self.device.sctpCapabilities.dict(),
            },
        }
        await self.websocket.send(json.dumps(req))
        ans = json.loads(await self.websocket.recv())

        # Create send_transport
        self.send_transport = self.device.createSendTransport(
            id=ans["data"]["id"],
            iceParameters=ans["data"]["iceParameters"],
            iceCandidates=ans["data"]["iceCandidates"],
            dtlsParameters=ans["data"]["dtlsParameters"],
            sctpParameters=ans["data"]["sctpParameters"],
        )

        @self.send_transport.on("connect")
        async def on_connect(dtlsParameters):
            reqId = self.generate_random_number()
            req = {
                "request": True,
                "id": reqId,
                "method": "connectWebRtcTransport",
                "data": {
                    "transportId": self.send_transport.id,
                    "dtlsParameters": dtlsParameters.dict(exclude_none=True),
                },
            }
            await self.websocket.send(json.dumps(req))
            ans = json.loads(await self.websocket.recv())
            print(ans)

        @self.send_transport.on("produce")
        async def on_produce(kind: str, rtpParameters, appData: dict):
            reqId = self.generate_random_number()
            req = {
                "id": reqId,
                "method": "produce",
                "request": True,
                "data": {
                    "transportId": self.send_transport.id,
                    "kind": kind,
                    "rtpParameters": rtpParameters.dict(exclude_none=True),
                    "appData": appData,
                },
            }
            await self.websocket.send(json.dumps(req))
            ans = json.loads(await self.websocket.recv())
            return ans["data"]["id"]
            

    async def produce(self):
        if self.send_transport is None:
            await self.create_send_transport()

        # Join room
        reqId = self.generate_random_number()
        req = {
            "request": True,
            "id": reqId,
            "method": "join",
            "data": {
                "displayName": "pymediasoup",
                "device": {"flag": "python", "name": "python", "version": "0.1.0"},
                "rtpCapabilities": self.device.rtpCapabilities.dict(exclude_none=True),
                "sctpCapabilities": self.device.sctpCapabilities.dict(
                    exclude_none=True
                ),
            },
        }
        await self.websocket.send(json.dumps(req))
        ans = json.loads(await self.websocket.recv())
        print(ans)

        # produce
        videoProducer: Producer = await self.send_transport.produce(
            track=self.video_track, stopTracks=False, appData={}
        )
        self.producers.append(videoProducer)


    async def close(self):
        for producer in self.producers:
            await producer.close()
        for task in self.tasks:
            task.cancel()
        if self.send_transport:
            await self.send_transport.close()


if __name__ == "__main__":

    peerId = round(random() * 1000000)
    roomId = sys.argv[1]
    uri = f"ws://localhost:8000?peerId=robot-{peerId}&roomId={roomId}"

    video_track = CameraStreamTrack(camera_id=0)
    client = RobotClient(uri=uri, video_track=video_track)

    try:
        asyncio.run(client.run())
    except KeyboardInterrupt:
        pass
    finally:
        asyncio.run(client.close())