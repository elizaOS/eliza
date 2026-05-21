#!/bin/sh
# elizaOS RV64 variant userland-bootstrap (Wave 2B / first-boot scaffold)
#
# First-boot bring-up for the Debian RV64 live image.
#
# Responsibilities:
#   1. Create the `elizaos` system user + group.
#   2. Create /var/lib/elizaos (state) and /etc/elizaos (config) with the
#      right ownership.
#   3. Generate a stable instance UUID at /etc/elizaos/instance-id.
#   4. Emit a single `elizaos-firstboot-ready instance=<uuid>` line on the
#      serial console (/dev/ttyS0) so the qemu-virt harness can detect OS
#      first-boot completion deterministically.
#   5. Enable elizaos-agent.service and start it when the agent binary exists.
#   6. Disable this first-boot service so it does not run again.
#
# Fail-closed: any step that cannot complete returns non-zero so the
# one-shot unit lands in `failed` state and the boot transcript records
# the gap. Do NOT silently continue.

set -eu

STATE_DIR="/var/lib/elizaos"
CONFIG_DIR="/etc/elizaos"
INSTANCE_ID_FILE="${CONFIG_DIR}/instance-id"
FIRST_BOOT_MARKER="${STATE_DIR}/.first-boot-complete"
SERIAL_CONSOLE="/dev/ttyS0"
AGENT_BIN="/opt/elizaos/bin/elizaos"
AGENT_HEALTH_SCRIPT="/usr/lib/elizaos/wait-agent-health.sh"
AGENT_HEALTH_URL="http://127.0.0.1:31337/api/health"

log() {
    printf '[elizaos-first-boot] %s\n' "$*"
}

# 1. Ensure elizaos system user + group exist.
if ! getent group elizaos >/dev/null 2>&1; then
    log "creating system group: elizaos"
    groupadd --system elizaos
fi

if ! getent passwd elizaos >/dev/null 2>&1; then
    log "creating system user: elizaos"
    useradd \
        --system \
        --gid elizaos \
        --home-dir "${STATE_DIR}" \
        --no-create-home \
        --shell /usr/sbin/nologin \
        --comment "elizaOS local agent" \
        elizaos
fi

# 2. State + config directories.
log "ensuring state directory: ${STATE_DIR}"
install -d -o elizaos -g elizaos -m 0750 "${STATE_DIR}"

log "ensuring config directory: ${CONFIG_DIR}"
install -d -o root -g elizaos -m 0750 "${CONFIG_DIR}"

# 3. Generate a stable instance UUID once.
if [ ! -s "${INSTANCE_ID_FILE}" ]; then
    if [ -r /proc/sys/kernel/random/uuid ]; then
        INSTANCE_UUID="$(cat /proc/sys/kernel/random/uuid)"
    elif command -v uuidgen >/dev/null 2>&1; then
        INSTANCE_UUID="$(uuidgen)"
    else
        log "ERROR: no UUID source (kernel random UUID or uuidgen) available"
        exit 1
    fi
    log "writing new instance id: ${INSTANCE_UUID}"
    umask 027
    printf '%s\n' "${INSTANCE_UUID}" > "${INSTANCE_ID_FILE}"
    chown root:elizaos "${INSTANCE_ID_FILE}"
    chmod 0640 "${INSTANCE_ID_FILE}"
else
    INSTANCE_UUID="$(cat "${INSTANCE_ID_FILE}")"
    log "reusing existing instance id: ${INSTANCE_UUID}"
fi

# 4. Emit the boot-ready marker on the serial console for the qemu harness.
#    Best-effort: if /dev/ttyS0 is not present (e.g. on a board without a
#    virt-style 16550), fall back to the kernel printk path so the line
#    still ends up in dmesg.
FIRSTBOOT_READY_LINE="elizaos-firstboot-ready instance=${INSTANCE_UUID}"
if [ -w "${SERIAL_CONSOLE}" ]; then
    log "emitting ready marker on ${SERIAL_CONSOLE}"
    printf '%s\n' "${FIRSTBOOT_READY_LINE}" > "${SERIAL_CONSOLE}"
elif [ -w /dev/kmsg ]; then
    log "serial console ${SERIAL_CONSOLE} not writable; using /dev/kmsg"
    printf '%s\n' "${FIRSTBOOT_READY_LINE}" > /dev/kmsg
else
    log "WARN: neither ${SERIAL_CONSOLE} nor /dev/kmsg writable; ready marker only in journal"
fi
log "${FIRSTBOOT_READY_LINE}"

# 5. Enable and start the agent when the packaged binary is present.
log "enabling elizaos-agent.service"
systemctl enable elizaos-agent.service
if [ -x "${AGENT_BIN}" ]; then
    log "starting elizaos-agent.service"
    timeout 10s systemctl start --no-block elizaos-agent.service || {
        log "WARN: elizaos-agent.service failed to queue"
    }
    if timeout 30s sh -c 'until systemctl is-active --quiet elizaos-agent.service; do sleep 1; done' \
        && "${AGENT_HEALTH_SCRIPT}" "${AGENT_HEALTH_URL}"; then
        AGENT_READY_LINE="elizaos-agent-ready instance=${INSTANCE_UUID}"
        if [ -w "${SERIAL_CONSOLE}" ]; then
            printf '%s\n' "${AGENT_READY_LINE}" > "${SERIAL_CONSOLE}"
        elif [ -w /dev/kmsg ]; then
            printf '%s\n' "${AGENT_READY_LINE}" > /dev/kmsg
        fi
        log "${AGENT_READY_LINE}"
    else
        log "WARN: elizaos-agent.service did not become active within 30s"
    fi
else
    log "agent binary missing at ${AGENT_BIN}; leaving elizaos-agent.service enabled but not started"
fi

# 6. Mark first-boot complete and disable this unit.
install -o elizaos -g elizaos -m 0640 /dev/null "${FIRST_BOOT_MARKER}"
date -u +%Y-%m-%dT%H:%M:%SZ > "${FIRST_BOOT_MARKER}"
chown elizaos:elizaos "${FIRST_BOOT_MARKER}"

log "disabling elizaos-first-boot.service"
systemctl disable elizaos-first-boot.service || true

log "first-boot complete"
