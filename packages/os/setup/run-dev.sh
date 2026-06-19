#!/usr/bin/env bash
set -e

LOG_DIR="${HOME}/.elizaos"
LOG_FILE="${LOG_DIR}/setup-dev.log"
mkdir -p "$LOG_DIR"

# Tee stderr to a debug log so failures (e.g. adb not running) survive past
# the visible "(adb not found)" fallback line.
exec 3>>"$LOG_FILE"

echo "Starting elizaOS Setup..."
echo "Logs: $LOG_FILE"
echo "Connected devices:"
if ! adb devices -l 2>>"$LOG_FILE"; then
  echo "  (adb not found — see $LOG_FILE for details)"
fi
echo ""

PORT="${ELIZA_SETUP_PORT:-3743}"
export ELIZA_SETUP_PORT="$PORT"
export VITE_ELIZA_SETUP_SERVER_URL="http://127.0.0.1:${PORT}"

bun run server.ts 2>>"$LOG_FILE" &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null; exit" SIGINT SIGTERM EXIT

sleep 1
echo "Backend running at $VITE_ELIZA_SETUP_SERVER_URL"
bun run dev
