#!/usr/bin/env bash
# Boot the newest elizaOS Live ISO from out/ in QEMU.
#
# Tails no longer emits an isohybrid image here, so boot it as a CD-ROM,
# not as a raw disk.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ISO="${1:-}"
if [ -z "${ISO}" ]; then
    ISO="$(ls -t out/*.iso 2>/dev/null | head -1 || true)"
fi

if [ -z "${ISO}" ] || [ ! -f "${ISO}" ]; then
    echo "no ISO found. Run 'just build' or pass an ISO path." >&2
    exit 1
fi

MEMORY="${ELIZAOS_QEMU_MEMORY:-4096}"
CPUS="${ELIZAOS_QEMU_CPUS:-2}"
SSH_PORT="${ELIZAOS_QEMU_SSH_PORT:-2224}"

qemu_args=(
    -m "${MEMORY}"
    -smp "${CPUS}"
    -cdrom "${ISO}"
    -boot d
    -netdev "user,id=net0,hostfwd=tcp::${SSH_PORT}-:22"
    -device virtio-net-pci,netdev=net0
    -vga virtio
    -display gtk,zoom-to-fit=on
    -device virtio-keyboard-pci
    -device virtio-tablet-pci
)

if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    qemu_args=(-enable-kvm -cpu host "${qemu_args[@]}")
else
    echo "warning: /dev/kvm is not available to this user; QEMU will be slower" >&2
fi

echo "booting ${ISO}"
echo "qemu memory: ${MEMORY} MiB, cpus: ${CPUS}, ssh forward: localhost:${SSH_PORT}"
exec qemu-system-x86_64 "${qemu_args[@]}"
