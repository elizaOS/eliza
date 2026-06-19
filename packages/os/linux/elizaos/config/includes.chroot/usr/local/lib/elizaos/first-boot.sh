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

    emit_marker "elizaos-agent-health-failed url=${AGENT_HEALTH_URL}"
    echo "elizaOS agent health probe failed: ${AGENT_HEALTH_URL}" >&2
    return 1
}

dump_to_serial() {
    "$@" 2>&1 | while IFS= read -r LINE; do
        echo "${LINE}"
        echo "${LINE}" >/dev/ttyS0 2>/dev/null || true
    done
}

dump_file_to_serial() {
    FILE="$1"
    if [ ! -f "${FILE}" ]; then
        echo "missing diagnostic file: ${FILE}"
        echo "missing diagnostic file: ${FILE}" >/dev/ttyS0 2>/dev/null || true
        return 0
    fi
    while IFS= read -r LINE; do
        echo "${LINE}"
        echo "${LINE}" >/dev/ttyS0 2>/dev/null || true
    done < "${FILE}"
}

dump_agent_diagnostics() {
    emit_marker "elizaos-agent-diagnostics-start"
    emit_marker "elizaos-agent-runtime-log-start"
    dump_file_to_serial /var/log/elizaos/agent-runtime.log || true
    dump_file_to_serial /var/lib/elizaos/agent-runtime.log || true
    emit_marker "elizaos-agent-runtime-log-end"
    dump_to_serial systemctl --no-pager --full status elizaos-agent.service || true
    dump_to_serial journalctl --no-pager -u elizaos-agent.service -n 120 || true
    emit_marker "elizaos-agent-diagnostics-end"
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
install -d -o elizaos -g elizaos -m 0750 /var/log/elizaos

emit_marker "elizaos-firstboot-ready instance=$(cat "${ETC}/instance-id")"

emit_marker "elizaos-agent-starting service=elizaos-agent.service"
systemctl start --no-block elizaos-agent.service
if ! wait_for_agent_health; then
    dump_agent_diagnostics
    exit 1
fi

emit_marker "elizaos-tui-starting url=${AGENT_BASE_URL}"
/usr/lib/elizaos/run-terminal-tui-smoke.sh "${AGENT_BASE_URL}"
emit_marker "elizaos-tui-ready url=${AGENT_BASE_URL}"

touch "${MARK}"
