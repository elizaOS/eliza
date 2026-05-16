#!/usr/bin/env bash
set -e
echo "Starting elizaOS AOSP Flasher..."
echo "Connected devices:"
adb devices -l 2>/dev/null || echo "  (adb not found)"
echo ""

bun run server.ts &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null; exit" SIGINT SIGTERM EXIT

sleep 1
echo "Backend running at http://localhost:3743"
bun run dev
