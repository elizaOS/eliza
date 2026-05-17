#!/usr/bin/env bash
set -e

# ============================================
# Simple Hello Utility - Environment Test
# Demonstrates basic functionality in the autonomous agent environment
# ============================================

MESSAGE="${1:-hello}"

# Early exit for invalid input
if [[ "$MESSAGE" == *"--help"* ]] || [[ "$MESSAGE" == *"-h"* ]]; then
    echo "Usage: ./hello.sh [message]"
    echo "  message: Text to output (default: 'hello')"
    echo ""
    echo "Examples:"
    echo "  ./hello.sh          # Outputs: hello"
    echo "  ./hello.sh world    # Outputs: world"
    echo "  ./hello.sh 'test message'  # Outputs: test message"
    exit 0
fi

# Validate input is not empty after stripping whitespace
if [[ -z "${MESSAGE// }" ]]; then
    echo "Error: Message cannot be empty or whitespace only" >&2
    exit 1
fi

# Main functionality - atomic and predictable
echo "$MESSAGE"