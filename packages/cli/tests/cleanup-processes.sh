#!/bin/bash

# Cleanup script for CLI tests
# Kills any lingering processes from test runs

echo "Cleaning up test processes..."

# Kill any bun processes running dist/index.js
pkill -f "bun.*dist/index.js" || true

# Kill processes on common test ports
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
lsof -ti:3100 | xargs kill -9 2>/dev/null || true

# Kill any node processes that might be lingering
pkill -f "node.*dist/index.js" || true

echo "Cleanup complete" 