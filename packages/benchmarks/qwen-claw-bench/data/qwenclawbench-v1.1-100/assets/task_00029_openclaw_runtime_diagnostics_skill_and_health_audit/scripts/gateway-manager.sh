#!/bin/bash
# OpenClaw Gateway Service Manager
# Used for manual recovery when systemd is unavailable

OPENCLAW_HOME="/home/admin/.openclaw"
CONFIG="$OPENCLAW_HOME/config/gateway.yaml"
PID_FILE="$OPENCLAW_HOME/state/gateway.pid"
LOG_FILE="$OPENCLAW_HOME/logs/gateway.log"
ENTRY_POINT="/home/admin/.local/share/pnpm/global/5/.pnpm/openclaw@2026.2.6-3_@napi-rs+canvas@0.1.90_@types+express@5.0.6_node-llama-cpp@3.15.1_signal-polyfill@0.2.2/node_modules/openclaw/dist/gateway/index.js"

case "$1" in
  start)
    echo "Starting OpenClaw gateway..."
    nohup node "$ENTRY_POINT" --config "$CONFIG" >> "$LOG_FILE" 2>&1 &
    echo "PID=$!" > "$PID_FILE"
    echo "STARTED=$(date -Iseconds)" >> "$PID_FILE"
    echo "ENTRY=$ENTRY_POINT" >> "$PID_FILE"
    echo "CMD=node $ENTRY_POINT --config $CONFIG" >> "$PID_FILE"
    echo "Gateway started with PID $!"
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      PID=$(grep "^PID=" "$PID_FILE" | cut -d= -f2)
      echo "Stopping gateway (PID: $PID)..."
      kill "$PID" 2>/dev/null
      rm -f "$PID_FILE"
      echo "Gateway stopped."
    else
      echo "No PID file found. Gateway may not be running."
    fi
    ;;
  restart)
    $0 stop
    sleep 2
    $0 start
    ;;
  status)
    if [ -f "$PID_FILE" ]; then
      PID=$(grep "^PID=" "$PID_FILE" | cut -d= -f2)
      if kill -0 "$PID" 2>/dev/null; then
        STARTED=$(grep "^STARTED=" "$PID_FILE" | cut -d= -f2)
        echo "Gateway is RUNNING (PID: $PID, started: $STARTED)"
        echo "Entry: $ENTRY_POINT"
        echo "Config: $CONFIG"
        echo "Log: $LOG_FILE"
      else
        echo "Gateway PID file exists but process is not running."
        echo "Stale PID: $PID"
      fi
    else
      echo "Gateway is NOT RUNNING (no PID file)"
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
