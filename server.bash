#!/bin/bash

# this script launches the node/python servers

node server/server.js $1 & # start the node server in the background
node_server_pid=$!

python3 server/server.py $1 & # start the python server in the background
python_server_pid=$!

# handle background processes on exit
cleanup() {
  pkill -f "node server/server.js" # kill the node server
  pkill -f "python3 server/server.py" # kill the python server
  echo "Cleanup complete. Exiting."
  exit 1 # Exit with a non-zero status to indicate abnormal termination
}

trap cleanup SIGINT

# keep servers alive
sleep infinity