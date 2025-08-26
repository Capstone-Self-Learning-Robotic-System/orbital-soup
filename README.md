# orbital-soup
VR orbital head streaming and control through media soup.

### Preliminaries

Ensure all necessary node packages are installed for server javascript code.

Ensure all necessary python packages are installed for orbital client and server code.

### Start mediasoup server

Run `node server/server.js ROOM_CODE`. Replace `ROOM_CODE` with your custom room code.

### Start robot client

On the robot side, ensure that the following script is running
```powershell
python lerobot/scripts/control_robot.py --robot.type=mobile_revobot --control.type=remote_revobot --control.viewer_ip=100.67.10.77 --control.viewer_port=1234
```

This script serves camera frames from the robot to clients that connect.

On the server side, run `python server/server.py ROOM_CODE`. Replace `ROOM_CODE` with your custom room code. This code connects to the robot-side server sending camera frames.

### Start web client

...
