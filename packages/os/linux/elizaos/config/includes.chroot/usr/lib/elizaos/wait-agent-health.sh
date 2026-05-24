#!/bin/sh
set -eu

URL="${1:-http://127.0.0.1:31337/api/health}"
DEADLINE_SECONDS="${ELIZA_AGENT_HEALTH_TIMEOUT_SECONDS:-60}"
END_AT="$(( $(date +%s) + DEADLINE_SECONDS ))"

emit_marker() {
    MSG="$*"
    echo "${MSG}"
    echo "${MSG}" >/dev/kmsg 2>/dev/null || true
    echo "${MSG}" >/dev/ttyS0 2>/dev/null || true
}

while [ "$(date +%s)" -le "${END_AT}" ]; do
    if /usr/bin/curl --fail --silent --show-error --max-time 2 "${URL}" >/dev/null; then
        emit_marker "elizaos-curl-health-ready url=${URL}"
        emit_marker "elizaos-agent-ready url=${URL}"
        exit 0
    fi
    sleep 1
done

emit_marker "elizaos-agent-health-failed url=${URL}"
echo "elizaos-agent health probe failed: ${URL}" >&2
exit 1
