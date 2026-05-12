#!/bin/bash
# check_process.sh — Check if a process is running
# Usage: ./check_process.sh <process_name>
#
# Exit codes:
#   0 — process is running
#   1 — process is NOT running
#   2 — usage error

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <process_name>" >&2
    exit 2
fi

PROCESS_NAME="$1"

if pgrep -f "${PROCESS_NAME}" > /dev/null 2>&1; then
    PID=$(pgrep -f "${PROCESS_NAME}" | head -1)
    UPTIME=$(ps -o etime= -p "${PID}" 2>/dev/null | tr -d ' ')
    echo "[OK] ${PROCESS_NAME} is running (PID: ${PID}, uptime: ${UPTIME})"
    exit 0
else
    echo "[FAIL] ${PROCESS_NAME} is NOT running"
    exit 1
fi
