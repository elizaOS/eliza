#!/bin/bash
# check_power_status.sh - Monitor system power state and battery
# Runs every 5 minutes via crontab

LOG_DIR="$HOME/openclaw/logs"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Check if on AC power or battery
POWER_SOURCE=$(pmset -g ps | head -1)

if echo "$POWER_SOURCE" | grep -q "AC Power"; then
    STATUS="ac_power"
elif echo "$POWER_SOURCE" | grep -q "Battery"; then
    BATTERY_PCT=$(pmset -g ps | grep -o '[0-9]*%' | tr -d '%')
    STATUS="battery_${BATTERY_PCT}pct"
    if [ "$BATTERY_PCT" -lt 20 ]; then
        echo "[$TIMESTAMP] WARNING: Battery low at ${BATTERY_PCT}%" >> "$LOG_DIR/power.log"
        # Send notification via openclaw
        node "$HOME/openclaw/notify.js" "Battery low: ${BATTERY_PCT}%"
    fi
else
    STATUS="unknown"
fi

echo "[$TIMESTAMP] Power status: $STATUS" >> "$LOG_DIR/power.log"
exit 0
