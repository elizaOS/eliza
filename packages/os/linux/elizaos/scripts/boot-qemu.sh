#!/usr/bin/env bash
# Boot the most recent ISO for a given arch under QEMU. Smoke harness
# only — used to validate that the unified ISO comes up to the GDM /
# greeter on every supported architecture.
#
# Usage: scripts/boot-qemu.sh <arch>
set -euo pipefail

ARCH="${1:-amd64}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${HERE}/out"

latest_iso() {
    ls -t "${OUT}"/elizaos-linux-"${ARCH}"-*.iso 2>/dev/null | head -1
}
ISO="$(latest_iso || true)"
if [ -z "${ISO}" ] || [ ! -f "${ISO}" ]; then
    echo "ERROR: no ISO found under ${OUT}/elizaos-linux-${ARCH}-*.iso" >&2
    exit 2
fi

echo "Booting ${ISO} under QEMU (${ARCH})..."

case "${ARCH}" in
    amd64)
        exec qemu-system-x86_64 \
            -machine q35,accel=kvm:tcg -cpu max -m 4096 -smp 2 \
            -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd \
            -cdrom "${ISO}" \
            -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
            -display gtk
        ;;
    arm64)
        exec qemu-system-aarch64 \
            -machine virt -cpu max -m 4096 -smp 2 \
            -drive if=pflash,format=raw,readonly=on,file=/usr/share/AAVMF/AAVMF_CODE.fd \
            -cdrom "${ISO}" \
            -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
            -display gtk
        ;;
    riscv64)
        exec "$(dirname "$0")/qemu_virt_boot_riscv64.sh" --iso "${ISO}"
        ;;
    *)
        echo "ERROR: unknown arch ${ARCH}" >&2
        exit 64
        ;;
esac
