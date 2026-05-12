#!/bin/bash
# monitor_cron.sh — Crontab entry helper for gateway monitoring
# Add to crontab: */30 * * * * /root/openclaw/scripts/monitor_cron.sh >> /root/openclaw/logs/monitor.log 2>&1

TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
LOG_FILE="/root/openclaw/logs/monitor.log"
START_SCRIPT="/root/openclaw/scripts/start_openclaw.sh"

if pgrep -f "openclaw.*gateway" > /dev/null 2>&1; then
    PID=$(pgrep -f "openclaw.*gateway" | head -1)
    echo "[${TIMESTAMP}] MONITOR: Process check — openclaw gateway running (PID ${PID})"
else
    echo "[${TIMESTAMP}] MONITOR: Process check — openclaw gateway NOT FOUND"
    echo "[${TIMESTAMP}] MONITOR: ACTION — Restarting openclaw gateway..."

    if [ -x "${START_SCRIPT}" ]; then
        bash "${START_SCRIPT}"
        sleep 3
        if pgrep -f "openclaw.*gateway" > /dev/null 2>&1; then
            NEW_PID=$(pgrep -f "openclaw.*gateway" | head -1)
            echo "[${TIMESTAMP}] MONITOR: openclaw gateway restarted successfully (PID ${NEW_PID})"
        else
            echo "[${TIMESTAMP}] MONITOR: ERROR — Failed to restart openclaw gateway!"
        fi
    else
        echo "[${TIMESTAMP}] MONITOR: ERROR — Start script not found or not executable: ${START_SCRIPT}"
    fi
fi
