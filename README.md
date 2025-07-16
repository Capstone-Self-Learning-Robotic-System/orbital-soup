# orbital-soup
VR orbital head streaming and control through media soup.

### Preliminaries

Ensure all necessary node packages are installed by running `npm install`.

Ensure all necessary python packages are installed, namely `opencv-python` and `pymediasoup`.

Ensure yarn is installed by running `yarn install`.

### Start mediasoup server

Run `node server/server.js`.

### Start robot client

Run `python robot/robot.py`.

### Start web client

Run `yarn start`, which opens the web app on [http://localhost:8080](http://localhost:8080).