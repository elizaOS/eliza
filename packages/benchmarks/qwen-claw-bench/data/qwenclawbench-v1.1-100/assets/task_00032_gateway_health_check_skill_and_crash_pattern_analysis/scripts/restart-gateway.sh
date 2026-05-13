#!/usr/bin/env bash
# OpenClaw Gateway Restart Script
# Gracefully restarts the gateway process
#
# Usage: ./restart-gateway.sh [--force]

set -euo pipefail

FORCE=false
PID_FILE="/var/run/openclaw-gateway.pid"
GATEWAY_BIN="openclaw"
STOP_TIMEOUT=10

for arg in "$@"; do
  case $arg in
    --force) FORCE=true ;;
  esac
done

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

get_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE"
  else
    pgrep -f "openclaw.*gateway" 2>/dev/null | head -1 || true
  fi
}

stop_gateway() {
  local pid
  pid=$(get_pid)

  if [ -z "$pid" ]; then
    log "No running gateway process found"
    return 0
  fi

  if [ "$FORCE" = true ]; then
    log "Force killing gateway (PID: $pid)"
    kill -9 "$pid" 2>/dev/null || true
  else
    log "Sending SIGTERM to gateway (PID: $pid)"
    kill -15 "$pid" 2>/dev/null || true

    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ $waited -lt $STOP_TIMEOUT ]; do
      sleep 1
      waited=$((waited + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
      log "Gateway did not stop gracefully, force killing"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  log "Gateway stopped"
}

start_gateway() {
  log "Starting OpenClaw gateway..."

  if command -v "$GATEWAY_BIN" &>/dev/null; then
    $GATEWAY_BIN gateway start
    log "Gateway started via CLI"
  elif command -v systemctl &>/dev/null; then
    sudo systemctl start openclaw-gateway
    log "Gateway started via systemctl"
  else
    log "ERROR: Cannot find a way to start the gateway"
    return 1
  fi
}

main() {
  log "=== Gateway Restart ==="
  stop_gateway
  sleep 2
  start_gateway
  log "=== Restart Complete ==="
}

main
