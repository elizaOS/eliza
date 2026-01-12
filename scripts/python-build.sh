#!/bin/bash
# Python build wrapper with retry logic and error handling
# This script handles transient failures during parallel Python builds

set -euo pipefail

MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
RETRY_DELAY="${RETRY_DELAY:-2}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-300}"

choose_build_cmd() {
    if command -v python3 >/dev/null 2>&1 && python3 -c "import build" >/dev/null 2>&1; then
        echo "python3 -m build"
        return 0
    fi

    if command -v python >/dev/null 2>&1 && python -c "import build" >/dev/null 2>&1; then
        echo "python -m build"
        return 0
    fi

    if command -v pyproject-build >/dev/null 2>&1; then
        echo "pyproject-build"
        return 0
    fi

    return 1
}

# Change to the directory containing pyproject.toml
if [ -n "${1:-}" ] && [ -d "${1}" ] && [ -f "${1}/pyproject.toml" ]; then
    cd "$1"
    shift
fi

BUILD_CMD="$(choose_build_cmd || true)"

if [ -z "${BUILD_CMD}" ]; then
    echo "❌ Python build tool not found. Install 'build' (pyproject-build) or make sure it is on PATH."
    exit 127
fi

ATTEMPT=1
while [ $ATTEMPT -le $MAX_ATTEMPTS ]; do
    if [ $ATTEMPT -gt 1 ]; then
        echo "⚠️  Python build attempt $ATTEMPT of $MAX_ATTEMPTS (retrying after ${RETRY_DELAY}s)..."
        sleep $RETRY_DELAY
        RETRY_DELAY=$((RETRY_DELAY * 2))  # Exponential backoff
    else
        echo "🔨 Building Python package..."
    fi
    
    # Run the build with a timeout to prevent hanging
    if command -v timeout >/dev/null 2>&1; then
        if timeout "${TIMEOUT_SECONDS}" ${BUILD_CMD} "$@" 2>&1; then
            echo "✅ Python build successful"
            exit 0
        else
            EXIT_CODE=$?
        fi
    else
        if ${BUILD_CMD} "$@" 2>&1; then
            echo "✅ Python build successful"
            exit 0
        else
            EXIT_CODE=$?
        fi
    fi

    if [ $EXIT_CODE -eq 124 ]; then
        echo "⏱️  Build timed out after ${TIMEOUT_SECONDS}s"
    else
        echo "❌ Build attempt $ATTEMPT failed with exit code $EXIT_CODE"
    fi
    
    if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
        ATTEMPT=$((ATTEMPT + 1))
    else
        echo "❌ Python build failed after $MAX_ATTEMPTS attempts"
        exit $EXIT_CODE
    fi
done

exit 1



