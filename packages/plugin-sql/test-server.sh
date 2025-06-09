#!/bin/bash
# Test script to run the server briefly and capture output

echo "Starting server test..."
bun run start &
SERVER_PID=$!

# Wait for 5 seconds
sleep 5

# Kill the server
kill $SERVER_PID 2>/dev/null

echo "Server test completed" 