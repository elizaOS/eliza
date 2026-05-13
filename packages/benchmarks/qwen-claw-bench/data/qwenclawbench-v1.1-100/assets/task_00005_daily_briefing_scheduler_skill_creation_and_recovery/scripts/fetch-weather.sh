#!/bin/bash
# Fetch weather data for daily briefing
# Called by cron job: daily-weather-report

set -euo pipefail

CITY="${1:-Beijing}"
FORMAT="j1"
CACHE_DIR="./data/weather-cache"
OUTPUT_FILE="./data/weather-latest.json"

mkdir -p "$CACHE_DIR"

echo "[$(date -Iseconds)] Fetching weather for ${CITY}..."

# Fetch from wttr.in
RESPONSE=$(curl -sf "https://wttr.in/${CITY}?format=${FORMAT}" 2>&1) || {
    echo "[ERROR] Failed to fetch weather data: $RESPONSE" >&2
    exit 1
}

# Validate JSON
echo "$RESPONSE" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null || {
    echo "[ERROR] Invalid JSON response from wttr.in" >&2
    exit 1
}

# Cache with date
DATE=$(date +%Y-%m-%d)
echo "$RESPONSE" > "${CACHE_DIR}/weather-${DATE}.json"
echo "$RESPONSE" > "$OUTPUT_FILE"

echo "[$(date -Iseconds)] Weather data saved to ${OUTPUT_FILE}"
echo "[$(date -Iseconds)] Cache: ${CACHE_DIR}/weather-${DATE}.json"
