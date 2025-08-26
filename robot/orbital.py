import threading
import json
import cv2
import time
import sys
import asyncio
import websockets
import base64
import datetime

import numpy as np
from random import random

import socket


# socket connection parameters
HOST = 'ms.lachserver.com'
PORT = 8080

# list of cameras to serve
CAMERAS = [0, 4, 8, 10]


class RobotClient:
    def __init__(self, client_socket, cameras):
        
        self.client_socket = client_socket
        self.cameras = cameras

        self.tasks = []
        self.closed = False

    # websocket receive task
    async def recv_msg_task(self):
        while True:
            if self.websocket is not None:
                message = json.loads(await self.websocket.recv())

    # Generates a random positive integer.
    def generate_random_number(self) -> int:
        return round(random() * 10000000)

    async def run(self):

        self.tasks.append(asyncio.create_task(self.recv_msg_task()))
        self.tasks.append(asyncio.create_task(self.produce()))
        
        while True:
            await asyncio.sleep(0.1)

    async def produce(self):

        # initialize cameras
        caps = [cv2.VideoCapture(camera) for camera in self.cameras]
        fps = 15

        for cap in caps:
            if not cap.isOpened():
                print("Error: Could not open camera.")
                return
        
        while True:
            start = time.time()

            frames = []

            for cap in caps:
                ret, frame = cap.read()
                if not ret:
                    print("Error: Could not read frame.")
                
                frames.append(cv2.resize(frame, (640, 480)))
            
            # combine frames side by side
            frame = np.concatenate(frames, axis=1)

            # add timestamp
            timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            cv2.putText(frame, timestamp, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2, cv2.LINE_AA)

            # encode frame as jpeg
            encode_param = [cv2.IMWRITE_JPEG_QUALITY, 70]
            _, frame = cv2.imencode('.jpg', frame, encode_param)

            # send to client and wait for response
            self.client_socket.sendall(np.array(frame).tobytes())
            self.client_socket.send(b'frame_end')
        
            end = time.time()
            time.sleep(max(1./fps - (end - start), 0))
        
        for cap in caps:
            cap.release()


    async def close(self):
        self.recording = False

        for task in self.tasks:
            task.cancel()


if __name__ == '__main__':

    threads = []

    peerId = str(int(random() * 1000000))
    roomId = sys.argv[1]

    # establish socket connection
    client_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client_socket.connect((HOST, PORT))

    # send peerId and roomId
    client_socket.send(peerId.encode('utf-8'))
    client_socket.send(roomId.encode('utf-8'))

    # initialize robot client
    client = RobotClient(client_socket=client_socket, cameras=CAMERAS)

    thread = threading.Thread(target=lambda: asyncio.run(client.run()))
    threads.append(thread)
    thread.start()
    
    while True:
        time.sleep(0.1)