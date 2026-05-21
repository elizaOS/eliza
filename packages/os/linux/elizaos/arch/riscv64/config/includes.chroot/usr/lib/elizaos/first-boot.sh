#!/bin/sh
set -eu

STATE_DIR="/var/lib/elizaos"
CONFIG_DIR="/etc/elizaos"
INSTANCE_ID_FILE="${CONFIG_DIR}/instance-id"
FIRST_BOOT_MARKER="${STATE_DIR}/.first-boot-complete"
SERIAL_CONSOLE="/dev/ttyS0"
AGENT_BIN="/opt/elizaos/bin/elizaos"
AGENT_HEALTH_URL="http://127.0.0.1:31337/api/health"

log() { printf '[elizaos-first-boot] %s\n' "$*"; }

emit_ready_line() {
    line="$1"
    if [ -w "${SERIAL_CONSOLE}" ]; then
        printf '%s\n' "${line}" > "${SERIAL_CONSOLE}"
    elif [ -w /dev/kmsg ]; then
        printf '%s\n' "${line}" > /dev/kmsg
    fi
    log "${line}"
}

getent group elizaos >/dev/null 2>&1 || groupadd --system elizaos
getent passwd elizaos >/dev/null 2>&1 || useradd --system --gid elizaos --home-dir "${STATE_DIR}" --no-create-home --shell /usr/sbin/nologin --comment "elizaOS local agent" elizaos
install -d -o elizaos -g elizaos -m 0750 "${STATE_DIR}"
install -d -o root -g elizaos -m 0750 "${CONFIG_DIR}"

if [ ! -s "${INSTANCE_ID_FILE}" ]; then
    INSTANCE_UUID="$(cat /proc/sys/kernel/random/uuid)"
    umask 027
    printf '%s\n' "${INSTANCE_UUID}" > "${INSTANCE_ID_FILE}"
    chown root:elizaos "${INSTANCE_ID_FILE}"
    chmod 0640 "${INSTANCE_ID_FILE}"
else
    INSTANCE_UUID="$(cat "${INSTANCE_ID_FILE}")"
fi

emit_ready_line "elizaos-firstboot-ready instance=${INSTANCE_UUID}"

if [ -x /opt/elizaos/launch/launch-screen.sh ]; then
    /opt/elizaos/launch/launch-screen.sh > "${SERIAL_CONSOLE}" 2>&1 || true
else
    emit_ready_line "elizaos-tui-ready screen=launch"
fi

systemctl enable elizaos-agent.service
if [ -x "${AGENT_BIN}" ]; then
    timeout 10s systemctl start --no-block elizaos-agent.service || true
    timeout 30s sh -c 'until systemctl is-active --quiet elizaos-agent.service; do sleep 1; done'
    CURL_BODY="$(curl --fail --silent --show-error --max-time 10 "${AGENT_HEALTH_URL}")"
    CURL_SHA256="$(printf '%s' "${CURL_BODY}" | sha256sum | awk '{print $1}')"
    emit_ready_line "elizaos-curl-health-ready url=${AGENT_HEALTH_URL} sha256=${CURL_SHA256}"
    emit_ready_line "elizaos-agent-ready instance=${INSTANCE_UUID}"
fi

install -o elizaos -g elizaos -m 0640 /dev/null "${FIRST_BOOT_MARKER}"
date -u +%Y-%m-%dT%H:%M:%SZ > "${FIRST_BOOT_MARKER}"
chown elizaos:elizaos "${FIRST_BOOT_MARKER}"
systemctl disable elizaos-first-boot.service || true
log "first-boot complete"
