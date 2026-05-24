#!/bin/bash
# Start HTTP server for the visual comparison viewer.
# Serves from packages/robot/ so STL relative paths work.
cd "$(dirname "$0")/../.."
PORT=8787
echo "Starting server at http://localhost:${PORT}/cad/asimov-feminine/viewer.html"
echo "Press Ctrl+C to stop."
python3 -m http.server $PORT
