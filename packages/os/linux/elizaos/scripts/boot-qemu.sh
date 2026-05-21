#!/usr/bin/env bash
# Boot the most recent ISO for a given arch under QEMU in an interactive
# desktop window. This is the "show me the GNOME desktop" path used by
# `make qemu-boot ARCH=<arch>` for all three supported arches.
#
# For headless, fail-closed marker-validation evidence on riscv64, use
# scripts/qemu_virt_boot_riscv64.sh (driven by scripts/qemu_virt_smoke.py)
# instead — that harness has its own callers and JSON evidence schema.
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

# Per-arch selection. Only the genuinely arch-specific bits differ:
#   QEMU_BIN  — qemu-system binary
#   MACHINE   — -machine arguments (accel/cpu where relevant)
#   FIRMWARE  — UEFI pflash drive(s)
#   CDROM     — how the ISO is attached as boot media
#   DISPLAY   — graphical output + input devices
# Everything else (memory, smp, netdev, the gtk window) is shared below.
MACHINE=()
FIRMWARE=()
CDROM=()
case "${ARCH}" in
    amd64)
        QEMU_BIN=qemu-system-x86_64
        MACHINE=(-machine q35,accel=kvm:tcg -cpu max)
        FIRMWARE=(-drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd)
        CDROM=(-cdrom "${ISO}")
        ;;
    arm64)
        QEMU_BIN=qemu-system-aarch64
        MACHINE=(-machine virt -cpu max)
        FIRMWARE=(-drive if=pflash,format=raw,readonly=on,file=/usr/share/AAVMF/AAVMF_CODE.fd)
        CDROM=(-cdrom "${ISO}")
        ;;
    riscv64)
        QEMU_BIN=qemu-system-riscv64
        MACHINE=(-machine virt -cpu max)
        # riscv64 virt boots via EDK2 UEFI when present, else OpenSBI default.
        # Mirrors the firmware selection in qemu_virt_boot_riscv64.sh.
        UEFI_CODE=/usr/share/qemu-efi-riscv64/RISCV_VIRT_CODE.fd
        UEFI_VARS=/usr/share/qemu-efi-riscv64/RISCV_VIRT_VARS.fd
        if [ -f "${UEFI_CODE}" ] && [ -f "${UEFI_VARS}" ]; then
            UEFI_VARS_RUNTIME="$(mktemp)"
            cp "${UEFI_VARS}" "${UEFI_VARS_RUNTIME}"
            trap 'rm -f "${UEFI_VARS_RUNTIME}"' EXIT
            FIRMWARE=(
                -drive "if=pflash,format=raw,unit=0,readonly=on,file=${UEFI_CODE}"
                -drive "if=pflash,format=raw,unit=1,file=${UEFI_VARS_RUNTIME}"
            )
        else
            FIRMWARE=(-bios default)
        fi
        # virt has no built-in IDE/SATA CD bus; attach the ISO as a virtio CD.
        CDROM=(-drive "file=${ISO},if=virtio,format=raw,media=cdrom,readonly=on")
        ;;
    *)
        echo "ERROR: unknown arch ${ARCH}" >&2
        exit 64
        ;;
esac

# Graphical desktop window. amd64/arm64 get a usable framebuffer from their
# machine. riscv64 virt has no default GPU, so add a virtio-gpu plus a USB
# pointer/keyboard so the GNOME session is usable interactively.
DISPLAY_ARGS=(-display gtk)
if [ "${ARCH}" = "riscv64" ]; then
    DISPLAY_ARGS=(
        -device virtio-gpu-pci
        -device qemu-xhci -device usb-tablet -device usb-kbd
        "${DISPLAY_ARGS[@]}"
    )
fi

exec "${QEMU_BIN}" \
    "${MACHINE[@]}" \
    -m 4096 -smp 2 \
    "${FIRMWARE[@]}" \
    "${CDROM[@]}" \
    -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
    "${DISPLAY_ARGS[@]}"
