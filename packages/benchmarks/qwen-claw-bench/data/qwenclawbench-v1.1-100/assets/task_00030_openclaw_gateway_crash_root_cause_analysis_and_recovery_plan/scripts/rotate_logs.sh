#!/bin/bash
# rotate_logs.sh - Rotate openclaw log files weekly
# Distractor: not needed for the gateway monitor task

LOG_DIR="/var/log/openclaw"
ARCHIVE_DIR="/var/log/openclaw/archive"
RETENTION_DAYS=30

mkdir -p "$ARCHIVE_DIR"

for logfile in "$LOG_DIR"/*.log; do
    [ -f "$logfile" ] || continue
    filename=$(basename "$logfile")
    timestamp=$(date '+%Y%m%d_%H%M%S')
    
    if [ "$(stat -c%s "$logfile" 2>/dev/null || stat -f%z "$logfile" 2>/dev/null)" -gt 10485760 ]; then
        echo "Rotating $filename (>10MB)"
        cp "$logfile" "$ARCHIVE_DIR/${filename%.log}_${timestamp}.log"
        gzip "$ARCHIVE_DIR/${filename%.log}_${timestamp}.log"
        truncate -s 0 "$logfile"
    fi
done

# Clean up old archives
find "$ARCHIVE_DIR" -name "*.gz" -mtime +$RETENTION_DAYS -delete

echo "Log rotation completed at $(date)"
