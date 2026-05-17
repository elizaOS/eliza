#!/bin/bash
# Smart Server Monitor - Enhanced version with trend analysis
# Tracks memory trends and provides predictive alerts

HISTORY_FILE="/tmp/mem-history.csv"
ALERT_THRESHOLD_MB=300
TREND_WINDOW=6

# Append current reading
MEM_AVAILABLE=$(free -m | awk '/^Mem:/ {print $7}')
TIMESTAMP=$(date +%s)
echo "${TIMESTAMP},${MEM_AVAILABLE}" >> "$HISTORY_FILE"

# Keep only last 24 readings
tail -n 24 "$HISTORY_FILE" > "${HISTORY_FILE}.tmp" && mv "${HISTORY_FILE}.tmp" "$HISTORY_FILE"

# Calculate trend (simple moving average comparison)
READINGS=$(tail -n $TREND_WINDOW "$HISTORY_FILE" | awk -F',' '{sum+=$2; count++} END {if(count>0) print sum/count; else print 0}')

echo "Current: ${MEM_AVAILABLE}MB | Avg(last ${TREND_WINDOW}): ${READINGS}MB"

if [ "$MEM_AVAILABLE" -lt "$ALERT_THRESHOLD_MB" ]; then
    echo "CRITICAL: Memory at ${MEM_AVAILABLE}MB - immediate attention required"
    exit 2
fi
