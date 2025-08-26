import socket
import threading
import json
import time
from random import random
import sys
import asyncio
import websockets
import datetime
import cv2
import struct

import numpy as np
import fractions

from urllib.parse import urlparse, parse_qs

# Import aiortc
from aiortc import VideoStreamTrack
from aiortc.mediastreams import AudioStreamTrack
from aiortc.contrib.media import MediaPlayer, MediaBlackhole, MediaRecorder
from av import VideoFrame

from pymediasoup import Device
from pymediasoup import AiortcHandler
from pymediasoup.transport import Transport
from pymediasoup.consumer import Consumer
from pymediasoup.producer import Producer
from pymediasoup.data_consumer import DataConsumer
from pymediasoup.data_producer import DataProducer
from pymediasoup.sctp_parameters import SctpStreamParameters


# mediasoup server socket parameters
HOST = '10.2.0.4'
PORT = 8080

# lerobot frame server socket parameters
SERVER_IP = "100.102.92.32"
SERVER_PORT = 60064

# global frame buffer
FRAME_BUFFER = {}
CLOSED = False


def recv_all(sock, size):
    """Receive exactly `size` bytes from socket."""
    buf = b""
    while len(buf) < size:
        chunk = sock.recv(size - len(buf))
        if not chunk:
            raise ConnectionError("Socket closed")
        buf += chunk
    return buf

def find_magic(sock):
    """Read until we find 'RBMJ' magic."""
    sync_buf = b""
    while True:
        byte = sock.recv(1)
        if not byte:
            raise ConnectionError("Socket closed while searching for magic")
        sync_buf += byte
        if len(sync_buf) > 4:
            sync_buf = sync_buf[-4:]  # keep last 4 bytes
        if sync_buf == b"RBMJ":
            return

def revo_stream_frames(sock):
    global FRAME_BUFFER

    while True:
        # Wait for start of packet
        start = time.time()
        find_magic(sock)

        # Number of frames
        num_frames = struct.unpack("!H", recv_all(sock, 2))[0]

        for i in range(num_frames):
            # Read name length
            name_len_bytes = recv_all(sock, 2)
            name_len = struct.unpack("!H", name_len_bytes)[0]

            # Sanity check
            if name_len > 256:
                # print(f"[WARN] Suspicious name_len={name_len}, resyncing...")
                find_magic(sock)
                break

            # Read camera name
            name_bytes = recv_all(sock, name_len)
            try:
                cam_name = name_bytes.decode("utf-8")
            except UnicodeDecodeError:
                # print(f"[WARN] Invalid UTF-8 for camera name, resyncing...")
                find_magic(sock)
                break

            # Read image length
            img_len_bytes = recv_all(sock, 4)
            img_len = struct.unpack("!I", img_len_bytes)[0]

            # Sanity check
            if img_len > 10_000_000:  # 10 MB safety cap
                # print(f"[WARN] Suspicious img_len={img_len}, resyncing...")
                find_magic(sock)
                break

            # Read image
            jpg_bytes = recv_all(sock, img_len)

            # Decode JPEG
            np_arr = np.frombuffer(jpg_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

            # copy to global frame buffer for tracks
            FRAME_BUFFER[cam_name] = np.copy(frame)


# custom video stream track for camera streaming
class CameraStreamTrack(VideoStreamTrack):
    def __init__(self, socket, cam_name):
        super().__init__()

        self.socket = socket
        self.cam_name = cam_name
        self.fps = 15

        # initialize frame count
        self.frame_count = 0

    async def recv(self):
        global FRAME_BUFFER

        self.frame_count += 1

        if FRAME_BUFFER is None:
            # wait for frame to be available
            while FRAME_BUFFER is None:
                await asyncio.sleep(0.01)
        
        # get specific camera frame from buffer
        frame = FRAME_BUFFER[self.cam_name]

        # create VideoFrame from numpy array for transport
        video_frame = VideoFrame.from_ndarray(frame, format="rgb24")
        video_frame.pts = self.frame_count
        video_frame.time_base = fractions.Fraction(1, self.fps)

        return video_frame


class RobotClient:
    def __init__(self, uri, video_tracks):
        self.uri = uri

        self.websocket = None
        self.device = None

        self.video_tracks = video_tracks

        self.send_transport = None
        self.producers = []

        self.tasks = []

    # websocket receive task
    async def recv_msg_task(self):
        while True:
            if self.websocket is not None:
                message = json.loads(await self.websocket.recv())

    # Generates a random positive integer.
    def generate_random_number(self) -> int:
        return round(random() * 10000000)

    async def run(self):
        global CLOSED

        self.websocket = await websockets.connect(origin="wss://100.122.121.80:8000", uri=self.uri, subprotocols=["protoo"])
        await self.load()
        await self.create_send_transport()
        
        for track_idx in range(len(self.video_tracks)):
            await self.produce(track_idx=track_idx)
        
        self.tasks.append(asyncio.create_task(self.recv_msg_task()))

        while True:
            await asyncio.sleep(0.1)
        
        await self.close()

    async def load(self):
        # Init device
        self.device = Device(
            handlerFactory=AiortcHandler.createFactory(tracks=self.video_tracks)
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
            # print("Connected transport: {}".format(self.send_transport.id))

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
            # print("Produced track: {}".format(ans["data"]["id"]))
            return ans["data"]["id"]
            

    async def produce(self, track_idx):
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

        # produce
        videoProducer: Producer = await self.send_transport.produce(
            track=self.video_tracks[track_idx], stopTracks=True, appData={}
        )
        self.producers.append(videoProducer)


    async def close(self):
        for producer in self.producers:
            await producer.close()
        for task in self.tasks:
            task.cancel()
        if self.send_transport:
            await self.send_transport.close()
        
        self.closed = True
        await self.websocket.close(code=1000, reason="Normal Closure")


if __name__ == '__main__':

    # create lerobot frame receiving socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect((SERVER_IP, SERVER_PORT))
    # print(f"[CLIENT] Connected to {SERVER_IP}:{SERVER_PORT}")

    threads = []

    # generate peerId, get roomId
    peerId = int(random() * 1000000)
    roomId = sys.argv[1]

    # start frame receiving thread
    stream_thread = threading.Thread(target=revo_stream_frames, args=(sock,))
    threads.append(stream_thread)
    stream_thread.start()

    # wait a moment for initial frames to arrive
    time.sleep(1)
    num_cameras = len(FRAME_BUFFER)

    # construct uri for robot client
    uri = f"wss://ms.lachserver.com:8000?peerId=robot-{peerId}&roomId={roomId}"

    # create video tracks and robot client
    video_tracks = []
    for i in range(num_cameras):
        video_tracks.append(CameraStreamTrack(sock, cam_name=list(FRAME_BUFFER.keys())[i]))
    
    client = RobotClient(uri=uri, video_tracks=video_tracks)

    try:
        asyncio.run(client.run())
    except KeyboardInterrupt:
        pass
    finally:
        asyncio.run(client.close())