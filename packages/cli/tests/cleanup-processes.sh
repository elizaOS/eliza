#!/bin/bash

echo "[CLEANUP] Cleaning up test processes..."

# Kill any elizaos processes
pkill -f "elizaos start" 2>/dev/null || true
pkill -f "elizaos dev" 2>/dev/null || true
pkill -f "bun.*dist/index.js" 2>/dev/null || true

# Kill processes on test ports
for port in 3000 3100 3456; do
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:$port | xargs kill -9 2>/dev/null || true
  fi
done

echo "[CLEANUP] Complete"
exit 0 