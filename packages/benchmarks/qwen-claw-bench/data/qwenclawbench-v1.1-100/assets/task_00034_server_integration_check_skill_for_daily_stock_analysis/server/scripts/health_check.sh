#!/bin/bash
# Server health check script
# Checks Docker containers, disk usage, and service status

set -euo pipefail

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
LOG_PREFIX="[$TIMESTAMP]"

echo "$LOG_PREFIX Running health check..."

# Check Docker containers
EXPECTED_CONTAINERS=("nginx-proxy" "redis" "postgres" "portfolio-api" "market-scraper")
for container in "${EXPECTED_CONTAINERS[@]}"; do
    STATUS=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo "not_found")
    if [ "$STATUS" != "running" ]; then
        echo "$LOG_PREFIX WARNING: Container $container is $STATUS"
    else
        echo "$LOG_PREFIX OK: $container is running"
    fi
done

# Disk usage
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | tr -d '%')
if [ "$DISK_USAGE" -gt 85 ]; then
    echo "$LOG_PREFIX WARNING: Disk usage at ${DISK_USAGE}%"
else
    echo "$LOG_PREFIX OK: Disk usage at ${DISK_USAGE}%"
fi

# Memory usage
MEM_USAGE=$(free | awk '/^Mem:/ {printf "%.0f", $3/$2 * 100}')
if [ "$MEM_USAGE" -gt 90 ]; then
    echo "$LOG_PREFIX WARNING: Memory usage at ${MEM_USAGE}%"
else
    echo "$LOG_PREFIX OK: Memory usage at ${MEM_USAGE}%"
fi

echo "$LOG_PREFIX Health check complete."
