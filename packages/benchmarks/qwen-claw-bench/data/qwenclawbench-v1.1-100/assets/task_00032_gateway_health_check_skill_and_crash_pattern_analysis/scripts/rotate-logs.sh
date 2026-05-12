#!/usr/bin/env bash
# OpenClaw Log Rotation Script
# Rotates gateway and health-check logs
# Typically run daily via cron

set -euo pipefail

LOG_DIR="/home/node/workspace/logs"
ARCHIVE_DIR="${LOG_DIR}/archive"
MAX_AGE_DAYS=30
MAX_SIZE_MB=50

mkdir -p "$ARCHIVE_DIR"

timestamp=$(date '+%Y%m%d_%H%M%S')

rotate_log() {
  local log_file="$1"
  local base_name
  base_name=$(basename "$log_file" .log)

  if [ ! -f "$log_file" ]; then
    return
  fi

  local size_kb
  size_kb=$(du -k "$log_file" | cut -f1)
  local size_mb=$((size_kb / 1024))

  if [ $size_mb -ge $MAX_SIZE_MB ]; then
    echo "Rotating $log_file ($size_mb MB)"
    cp "$log_file" "${ARCHIVE_DIR}/${base_name}_${timestamp}.log"
    gzip "${ARCHIVE_DIR}/${base_name}_${timestamp}.log"
    truncate -s 0 "$log_file"
  fi
}

# Rotate main logs
rotate_log "${LOG_DIR}/gateway.log"
rotate_log "${LOG_DIR}/health-check.log"

# Clean old archives
find "$ARCHIVE_DIR" -name "*.log.gz" -mtime +${MAX_AGE_DAYS} -delete 2>/dev/null || true

echo "Log rotation complete"
