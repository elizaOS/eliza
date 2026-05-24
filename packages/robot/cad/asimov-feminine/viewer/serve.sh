#!/bin/bash
# Serve the robot viewer from packages/robot/
# Then open http://localhost:8765/cad/asimov-feminine/viewer/index.html
cd "$(dirname "$0")/../../.."
PORT=8765
echo "Serving on http://localhost:$PORT/cad/asimov-feminine/viewer/index.html"
open "http://localhost:$PORT/cad/asimov-feminine/viewer/index.html"
python3 -m http.server $PORT
