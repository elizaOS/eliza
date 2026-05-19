#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Starting elizaOS USB Installer..."
echo "  Backend API → http://localhost:3742"
echo "  UI          → http://localhost:5174"
echo ""

# Start the Bun backend server
bun run server.ts &
SERVER_PID=$!

# Give the server a moment to bind
sleep 0.5

# Start Vite dev server (proxies /api/* to the backend)
bun run dev &
VITE_PID=$!

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  kill "$VITE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for either process to exit
wait "$VITE_PID" "$SERVER_PID"
