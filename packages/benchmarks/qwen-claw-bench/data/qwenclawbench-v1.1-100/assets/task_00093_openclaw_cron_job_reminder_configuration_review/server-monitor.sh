#!/bin/bash
# Server Memory Monitor Script
# Designed for low-memory VPS (1.6GB RAM + 8GB swap)

ALERT_THRESHOLD_MB=300
LOG_FILE="/tmp/server-monitor.log"

# Get memory info
MEM_TOTAL=$(free -m | awk '/^Mem:/ {print $2}')
MEM_AVAILABLE=$(free -m | awk '/^Mem:/ {print $7}')
SWAP_TOTAL=$(free -m | awk '/^Swap:/ {print $2}')
SWAP_USED=$(free -m | awk '/^Swap:/ {print $3}')
CPU_LOAD=$(uptime | awk -F'load average:' '{print $2}' | awk '{print $1}' | tr -d ',')
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}')

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$TIMESTAMP] Memory Check" >> "$LOG_FILE"
echo "  Total RAM: ${MEM_TOTAL}MB" >> "$LOG_FILE"
echo "  Available: ${MEM_AVAILABLE}MB" >> "$LOG_FILE"
echo "  Swap Used: ${SWAP_USED}MB / ${SWAP_TOTAL}MB" >> "$LOG_FILE"
echo "  CPU Load:  ${CPU_LOAD}" >> "$LOG_FILE"
echo "  Disk:      ${DISK_USAGE}" >> "$LOG_FILE"

# Check if memory is critically low
if [ "$MEM_AVAILABLE" -lt "$ALERT_THRESHOLD_MB" ]; then
    echo "  STATUS: CRITICAL - Memory below ${ALERT_THRESHOLD_MB}MB!" >> "$LOG_FILE"
    echo "ALERT:LOW_MEMORY:${MEM_AVAILABLE}MB"
    exit 1
else
    echo "  STATUS: OK" >> "$LOG_FILE"
    echo "OK:${MEM_AVAILABLE}MB available"
    exit 0
fi
