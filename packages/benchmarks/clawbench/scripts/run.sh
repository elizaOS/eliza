#!/bin/bash
# Run ClawBench
#
# Usage:
#   ./scripts/run.sh [scenario] [variant]
#
#   ./scripts/run.sh inbox_triage baseline
#   ./scripts/run.sh morning_brief optimized
#   ./scripts/run.sh --list                  # list available scenarios
#
# Prerequisites:
#   1. cp .env.example .env
#   2. Edit .env with your API key

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(dirname "$SCRIPT_DIR")"

cd "$SANDBOX_DIR"

# Handle --list flag
if [ "$1" == "--list" ] || [ "$1" == "-l" ]; then
    python scripts/run_episode.py --list
    exit 0
fi

# Check for .env file
if [ ! -f ".env" ]; then
    echo "ERROR: .env file not found"
    echo ""
    echo "Create it from the example:"
    echo "  cp .env.example .env"
    echo ""
    echo "Then edit .env and add your API key"
    exit 1
fi

# Source .env to check for API key
set -a
source .env
set +a

if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
    echo "ERROR: No API key set in .env"
    echo ""
    echo "Edit .env and set ANTHROPIC_API_KEY or OPENAI_API_KEY"
    exit 1
fi

# Parse arguments (override .env defaults)
SCENARIO="${1:-${SCENARIO:-client_escalation}}"
VARIANT="${2:-${VARIANT:-optimized}}"

# Get token and port from .env or use defaults
TOKEN="${OPENCLAW_GATEWAY_TOKEN:-sandbox-token-12345}"
PORT="${OPENCLAW_PORT:-18790}"

echo ""
echo "=============================================="
echo "Starting ClawBench"
echo "=============================================="
echo ""
echo "Scenario: $SCENARIO"
echo "Variant:  $VARIANT"
echo ""
echo "Dashboard: http://localhost:${PORT}/?token=${TOKEN}"
echo "Mock tools: http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Build and run — init container handles workspace setup
SCENARIO="$SCENARIO" VARIANT="$VARIANT" docker compose up --build
