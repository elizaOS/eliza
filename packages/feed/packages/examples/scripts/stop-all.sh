#!/bin/bash
set -e

# Stop all development services

echo "🛑 Stopping Feed Agent Development Environment"
echo "=================================================="

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
EXAMPLES_DIR="$(dirname "$SCRIPT_DIR")"

# Function to stop process by PID file
stop_by_pid() {
    local pidfile=$1
    local name=$2
    
    if [ -f "$pidfile" ]; then
        local pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            echo "✓ Stopped $name (PID: $pid)"
        else
            echo "- $name already stopped"
        fi
        rm -f "$pidfile"
    else
        echo "- $name not running (no PID file)"
    fi
}

# Stop services
stop_by_pid "$EXAMPLES_DIR/logs/a2a-server.pid" "A2A Server"
stop_by_pid "$EXAMPLES_DIR/logs/anvil.pid" "Anvil"

# Also kill any remaining processes on the ports
pkill -f "anvil.*8545" 2>/dev/null || true
pkill -f "local-a2a-server" 2>/dev/null || true

echo ""
echo "All services stopped."
