#!/bin/sh
set -eu

URL="${1:-http://127.0.0.1:31337/api/health}"
DEADLINE_SECONDS="${ELIZA_AGENT_HEALTH_TIMEOUT_SECONDS:-30}"
END_AT="$(( $(date +%s) + DEADLINE_SECONDS ))"

while [ "$(date +%s)" -le "${END_AT}" ]; do
    if /usr/bin/curl --fail --silent --show-error --max-time 2 "${URL}" >/dev/null; then
        echo "elizaos-agent-ready url=${URL}"
        exit 0
    fi
    sleep 1
done

echo "elizaos-agent health probe failed: ${URL}" >&2
exit 1
