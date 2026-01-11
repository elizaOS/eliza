#!/bin/bash
# Python build wrapper with retry logic and error handling
# This script handles transient failures during parallel Python builds

set -euo pipefail

MAX_ATTEMPTS=3
RETRY_DELAY=2
ATTEMPT=1

# Change to the directory containing pyproject.toml
if [ -n "${1:-}" ]; then
    cd "$1"
fi

while [ $ATTEMPT -le $MAX_ATTEMPTS ]; do
    if [ $ATTEMPT -gt 1 ]; then
        echo "⚠️  Python build attempt $ATTEMPT of $MAX_ATTEMPTS (retrying after ${RETRY_DELAY}s)..."
        sleep $RETRY_DELAY
        RETRY_DELAY=$((RETRY_DELAY * 2))  # Exponential backoff
    else
        echo "🔨 Building Python package..."
    fi
    
    # Run the build with a timeout to prevent hanging
    if timeout 300 python3 -m build "$@" 2>&1; then
        echo "✅ Python build successful"
        exit 0
    else
        EXIT_CODE=$?
        if [ $EXIT_CODE -eq 124 ]; then
            echo "⏱️  Build timed out after 5 minutes"
        else
            echo "❌ Build attempt $ATTEMPT failed with exit code $EXIT_CODE"
        fi
        
        if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
            ATTEMPT=$((ATTEMPT + 1))
        else
            echo "❌ Python build failed after $MAX_ATTEMPTS attempts"
            exit 1
        fi
    fi
done

exit 1



