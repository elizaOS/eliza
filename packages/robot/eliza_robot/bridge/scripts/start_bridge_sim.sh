#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

export PYTHONPATH="$ROOT_DIR:${PYTHONPATH:-}"
TRACE_LOG_PATH="${TRACE_LOG_PATH:-}"
exec python -m bridge.server \
  --backend ros_sim \
  --host 0.0.0.0 \
  --port 9100 \
  --queue-size 256 \
  --max-commands-per-sec 30 \
  --deadman-timeout-sec 1.0 \
  --trace-log-path "$TRACE_LOG_PATH"

