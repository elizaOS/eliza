#!/bin/bash
# check_openclaw.sh - Check if openclaw gateway is running and restart if needed
# Used by cron monitor: system-gateway-monitor

LOGFILE="/var/log/openclaw/monitor.log"
PIDFILE="/var/run/openclaw.pid"

check_process() {
    if pgrep -x "openclaw" > /dev/null 2>&1; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [INFO] openclaw process is running (PID: $(pgrep -x openclaw))" >> "$LOGFILE"
        return 0
    else
        echo "$(date '+%Y-%m-%d %H:%M:%S') [WARN] openclaw process is NOT running" >> "$LOGFILE"
        return 1
    fi
}

start_openclaw() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [INFO] Attempting to start openclaw gateway..." >> "$LOGFILE"
    openclaw gateway start
    sleep 2
    if pgrep -x "openclaw" > /dev/null 2>&1; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [INFO] openclaw started successfully (PID: $(pgrep -x openclaw))" >> "$LOGFILE"
    else
        echo "$(date '+%Y-%m-%d %H:%M:%S') [ERROR] Failed to start openclaw" >> "$LOGFILE"
        exit 1
    fi
}

if ! check_process; then
    start_openclaw
fi
