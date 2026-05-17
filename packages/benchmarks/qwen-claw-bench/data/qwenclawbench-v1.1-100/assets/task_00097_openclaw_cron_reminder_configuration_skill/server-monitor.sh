#!/bin/bash
# Server Memory Monitor Script
# Designed for low-memory environments (1.6GB RAM + 8GB swap)

THRESHOLD_WARNING=400    # MB
THRESHOLD_CRITICAL=200   # MB
SWAP_WARNING=70          # percent
LOG_FILE="/var/log/openclaw-memory.log"

timestamp=$(date '+%Y-%m-%d %H:%M:%S')

# Get memory info
total_mem=$(free -m | awk '/^Mem:/ {print $2}')
used_mem=$(free -m | awk '/^Mem:/ {print $3}')
avail_mem=$(free -m | awk '/^Mem:/ {print $7}')
swap_total=$(free -m | awk '/^Swap:/ {print $2}')
swap_used=$(free -m | awk '/^Swap:/ {print $3}')

if [ "$swap_total" -gt 0 ]; then
    swap_percent=$((swap_used * 100 / swap_total))
else
    swap_percent=0
fi

# Log current state
echo "[$timestamp] RAM: ${used_mem}/${total_mem}MB (available: ${avail_mem}MB) | Swap: ${swap_used}/${swap_total}MB (${swap_percent}%)" >> "$LOG_FILE"

# Check thresholds
STATUS="OK"
if [ "$avail_mem" -lt "$THRESHOLD_CRITICAL" ]; then
    STATUS="CRITICAL"
    echo "[$timestamp] CRITICAL: Available memory is ${avail_mem}MB (threshold: ${THRESHOLD_CRITICAL}MB)" >> "$LOG_FILE"
elif [ "$avail_mem" -lt "$THRESHOLD_WARNING" ]; then
    STATUS="WARNING"
    echo "[$timestamp] WARNING: Available memory is ${avail_mem}MB (threshold: ${THRESHOLD_WARNING}MB)" >> "$LOG_FILE"
fi

if [ "$swap_percent" -gt "$SWAP_WARNING" ]; then
    STATUS="WARNING"
    echo "[$timestamp] WARNING: Swap usage at ${swap_percent}% (threshold: ${SWAP_WARNING}%)" >> "$LOG_FILE"
fi

# Top memory consumers
echo "[$timestamp] Top 5 memory processes:" >> "$LOG_FILE"
ps aux --sort=-%mem | head -6 | tail -5 >> "$LOG_FILE"

# Output for OpenClaw agent consumption
echo "STATUS: $STATUS"
echo "RAM_AVAILABLE: ${avail_mem}MB"
echo "RAM_TOTAL: ${total_mem}MB"
echo "SWAP_USED: ${swap_percent}%"
echo "TOP_PROCESSES:"
ps aux --sort=-%mem | head -6 | tail -5 | awk '{printf "  %s: %.1f%% (%sMB)\n", $11, $4, $6/1024}'
