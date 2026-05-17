#!/bin/bash
# Smart Server Monitor - Enhanced version with trending
# Tracks memory over time and detects leaks

DATA_DIR="/tmp/openclaw-monitor"
mkdir -p "$DATA_DIR"

HISTORY_FILE="$DATA_DIR/mem_history.csv"
ALERT_COOLDOWN_FILE="$DATA_DIR/last_alert"

# Record current snapshot
timestamp=$(date '+%Y-%m-%d %H:%M:%S')
epoch=$(date +%s)
avail_mem=$(free -m | awk '/^Mem:/ {print $7}')
swap_used=$(free -m | awk '/^Swap:/ {print $3}')

echo "${epoch},${avail_mem},${swap_used}" >> "$HISTORY_FILE"

# Keep only last 72 entries (12 hours at 10 min intervals)
tail -72 "$HISTORY_FILE" > "$DATA_DIR/tmp_history" && mv "$DATA_DIR/tmp_history" "$HISTORY_FILE"

# Calculate 1-hour trend
entries_1h=$(tail -6 "$HISTORY_FILE")
if [ $(echo "$entries_1h" | wc -l) -ge 2 ]; then
    first_avail=$(echo "$entries_1h" | head -1 | cut -d',' -f2)
    last_avail=$(echo "$entries_1h" | tail -1 | cut -d',' -f2)
    trend=$((last_avail - first_avail))
    echo "1H_TREND: ${trend}MB"
fi

echo "TIMESTAMP: $timestamp"
echo "AVAILABLE_MB: $avail_mem"
echo "SWAP_USED_MB: $swap_used"

# Detect potential memory leak (consistent decline over 3+ readings)
declining=0
prev=""
while IFS=',' read -r ts mem sw; do
    if [ -n "$prev" ] && [ "$mem" -lt "$prev" ]; then
        declining=$((declining + 1))
    else
        declining=0
    fi
    prev=$mem
done < <(tail -6 "$HISTORY_FILE")

if [ "$declining" -ge 4 ]; then
    echo "LEAK_WARNING: Memory has been declining for $declining consecutive readings"
fi
