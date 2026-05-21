#!/bin/sh
# Idempotent first-boot bootstrap. Provisions the elizaos user state,
# instance UUID, and marks completion so the unit self-disables.
set -eu

STATE=/var/lib/elizaos
ETC=/etc/elizaos
MARK="${STATE}/.first-boot-complete"

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

touch "${MARK}"
echo "elizaos-firstboot-ready instance=$(cat "${ETC}/instance-id")" >/dev/kmsg || true
