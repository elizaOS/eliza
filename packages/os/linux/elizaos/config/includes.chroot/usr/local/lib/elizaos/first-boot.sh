#!/bin/sh
# Idempotent first-boot bootstrap. Provisions elizaOS user state, validates
# the local agent and TUI path, and marks completion only after boot proof
# markers have been emitted.
set -eu

STATE=/var/lib/elizaos
ETC=/etc/elizaos
MARK="${STATE}/.first-boot-complete"
AGENT_HEALTH_URL="${ELIZA_AGENT_HEALTH_URL:-http://127.0.0.1:31337/api/health}"
AGENT_BASE_URL="${ELIZA_AGENT_BASE_URL:-http://127.0.0.1:31337}"
DEADLINE_SECONDS="${ELIZA_AGENT_HEALTH_TIMEOUT_SECONDS:-90}"

emit_marker() {
    MSG="$*"
    echo "${MSG}"
    echo "${MSG}" >/dev/kmsg 2>/dev/null || true
    echo "${MSG}" >/dev/ttyS0 2>/dev/null || true
}

wait_for_agent_health() {
    END_AT="$(( $(date +%s) + DEADLINE_SECONDS ))"
    while [ "$(date +%s)" -le "${END_AT}" ]; do
        if /usr/bin/curl --fail --silent --show-error --max-time 2 "${AGENT_HEALTH_URL}" >/dev/null; then
            emit_marker "elizaos-curl-health-ready url=${AGENT_HEALTH_URL}"
            emit_marker "elizaos-agent-ready url=${AGENT_HEALTH_URL}"
            return 0
        fi
        sleep 1
    done

    echo "elizaOS agent health probe failed: ${AGENT_HEALTH_URL}" >&2
    return 1
}

if [ -e "${MARK}" ]; then
    exit 0
fi

mkdir -p "${STATE}" "${ETC}"

if [ ! -s "${ETC}/instance-id" ]; then
    if command -v uuidgen >/dev/null 2>&1; then
        uuidgen > "${ETC}/instance-id"
    else
        cat /proc/sys/kernel/random/uuid > "${ETC}/instance-id"
    fi
fi

chown -R elizaos:elizaos "${STATE}"
chmod 0750 "${STATE}"

emit_marker "elizaos-firstboot-ready instance=$(cat "${ETC}/instance-id")"

systemctl start elizaos-agent.service
wait_for_agent_health

/usr/lib/elizaos/run-terminal-tui-smoke.sh "${AGENT_BASE_URL}"
emit_marker "elizaos-tui-ready url=${AGENT_BASE_URL}"

touch "${MARK}"
