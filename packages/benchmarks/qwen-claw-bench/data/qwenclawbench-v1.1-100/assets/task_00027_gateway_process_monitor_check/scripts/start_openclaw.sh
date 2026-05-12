#!/bin/bash
# start_openclaw.sh — Start the OpenClaw gateway daemon
# Usage: ./start_openclaw.sh [--foreground]

set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-/root/openclaw}"
OPENCLAW_BIN="${OPENCLAW_HOME}/bin/openclaw"
LOG_DIR="${OPENCLAW_HOME}/logs"
PID_FILE="${OPENCLAW_HOME}/run/openclaw.pid"
CONFIG_FILE="${OPENCLAW_HOME}/config/gateway.yaml"

mkdir -p "${LOG_DIR}" "$(dirname "${PID_FILE}")"

if [ ! -f "${OPENCLAW_BIN}" ]; then
    echo "[ERROR] OpenClaw binary not found at ${OPENCLAW_BIN}" >&2
    exit 1
fi

if [ ! -f "${CONFIG_FILE}" ]; then
    echo "[ERROR] Config file not found at ${CONFIG_FILE}" >&2
    exit 1
fi

# Check if already running
if [ -f "${PID_FILE}" ]; then
    EXISTING_PID=$(cat "${PID_FILE}")
    if kill -0 "${EXISTING_PID}" 2>/dev/null; then
        echo "[INFO] OpenClaw is already running (PID: ${EXISTING_PID})"
        exit 0
    else
        echo "[WARN] Stale PID file found. Cleaning up."
        rm -f "${PID_FILE}"
    fi
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if [ "${1:-}" = "--foreground" ]; then
    echo "[${TIMESTAMP}] Starting OpenClaw gateway in foreground..."
    exec "${OPENCLAW_BIN}" gateway start --config "${CONFIG_FILE}"
else
    echo "[${TIMESTAMP}] Starting OpenClaw gateway daemon..."
    nohup "${OPENCLAW_BIN}" gateway start --config "${CONFIG_FILE}" \
        >> "${LOG_DIR}/gateway.log" 2>&1 &
    echo $! > "${PID_FILE}"
    echo "[${TIMESTAMP}] OpenClaw gateway started (PID: $!)"
fi
