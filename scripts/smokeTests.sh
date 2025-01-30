#!/bin/bash

# Strict mode, exit on error, undefined variables, and pipe failures
set -euo pipefail

# Print some information about the environment to aid in case of troubleshooting

echo "node version:"
node --version

echo "python version:"
python3 --version

echo "make version:"
make --version

echo "gcc version:"
gcc --version

echo "g++ version:"
g++ --version

# Check Node.js version
REQUIRED_NODE_VERSION=23
CURRENT_NODE_VERSION=$(node -v | cut -d'.' -f1 | sed 's/v//')

if (( CURRENT_NODE_VERSION < REQUIRED_NODE_VERSION )); then
    echo "Error: Node.js version must be $REQUIRED_NODE_VERSION or higher. Current version is $CURRENT_NODE_VERSION."
    exit 1
fi

# Autodetect project directory relative to this script's path
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$PROJECT_DIR"

cp .env.example .env

pnpm clean

pnpm install -r --no-frozen-lockfile

pnpm build

# Create temp file and ensure cleanup
OUTFILE="$(mktemp)"
trap 'rm -f "$OUTFILE"' EXIT
echo "Using temporary output file: $OUTFILE"

# Add timeout configuration
TIMEOUT=1200  # 60 seconds represented as 600 tenths of a second
INTERVAL=5   # Represent 0.5 seconds as 5 tenths of a second
TIMER=0

# Start the application and capture logs in the background
# 27 includes success and that's what the level we're looking for is
DEFAULT_LOG_LEVEL=success pnpm start --character=characters/trump.character.json > "$OUTFILE" 2>&1 &

APP_PID=$!  # Capture the PID of the background process

(
  # Wait for the ready message with timeout
  while true; do
    if (( TIMER >= TIMEOUT )); then
        >&2 echo "ERROR: Timeout waiting for application to start after $((TIMEOUT / 10)) seconds"
        cat $OUTFILE
        kill $APP_PID  # Terminate the pnpm process
        exit 1
    fi

    if grep -q "REST API bound to 0.0.0.0" "$OUTFILE"; then
        >&2 echo "SUCCESS: Direct Client API is ready! Proceeding..."
        break
    fi

    sleep 0.5
    TIMER=$((TIMER + INTERVAL))
  done
)

# Gracefully terminate the application if needed
kill $APP_PID
wait $APP_PID 2>/dev/null || true  # Ensure the process is cleaned up

RESULT=$?

# Output logs
echo "----- OUTPUT START -----"
cat "$OUTFILE"
echo "----- OUTPUT END -----"

# Check the application exit code
if [[ $RESULT -ne 0 ]]; then
    echo "Error: 'pnpm start' command exited with an error (code: $RESULT)"
    exit 1
fi

# Final validation
if grep -q "Server closed successfully" "$OUTFILE"; then
    echo "Smoke Test completed successfully."
else
    echo "Error: The output does not contain the expected termination message but was completed."
    echo "Smoke Test completed without completion message."
    # Exit gracefully
fi
