#!/usr/bin/env bash
# Boot an elizaOS live ISO through the architecture's real QEMU boundary.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${ELIZAOS_ARCH:-amd64}"
FIRMWARE="${ELIZAOS_QEMU_FIRMWARE:-uefi}"
if [[ "$(uname -s)" == Darwin ]]; then
  DEFAULT_DISPLAY_BACKEND="cocoa,show-cursor=on"
else
  DEFAULT_DISPLAY_BACKEND="gtk,zoom-to-fit=on"
fi
DISPLAY_BACKEND="${ELIZAOS_QEMU_DISPLAY:-${DEFAULT_DISPLAY_BACKEND}}"
MEMORY="${ELIZAOS_QEMU_MEMORY:-6144}"
CPUS="${ELIZAOS_QEMU_CPUS:-4}"
SSH_PORT="${ELIZAOS_QEMU_SSH_PORT:-2224}"
AUDIO_BACKEND="${ELIZAOS_QEMU_AUDIO:-none}"
ISO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) ARCH="${2:?--arch requires a value}"; shift 2 ;;
    --firmware) FIRMWARE="${2:?--firmware requires a value}"; shift 2 ;;
    --display) DISPLAY_BACKEND="${2:?--display requires a value}"; shift 2 ;;
    --memory) MEMORY="${2:?--memory requires a value}"; shift 2 ;;
    --cpus) CPUS="${2:?--cpus requires a value}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:?--ssh-port requires a value}"; shift 2 ;;
    --audio) AUDIO_BACKEND="${2:?--audio requires a value}"; shift 2 ;;
    -h|--help)
      echo "usage: $0 [--arch amd64|arm64|riscv64] [--firmware bios|uefi] image.iso"
      exit 0
      ;;
    --*) echo "unknown option: $1" >&2; exit 64 ;;
    *)
      [[ -z "${ISO}" ]] || { echo "only one ISO may be specified" >&2; exit 64; }
      ISO="$1"; shift
      ;;
  esac
done

if [[ -z "${ISO}" ]]; then
  ISO="$(ls -t "${ROOT}"/out/elizaos-linux-${ARCH}-*.iso 2>/dev/null | head -1 || true)"
fi
[[ -f "${ISO}" ]] || { echo "no ${ARCH} ISO found; pass one explicitly" >&2; exit 1; }
[[ "${FIRMWARE}" == uefi || "${FIRMWARE}" == bios ]] || {
  echo "ELIZAOS_QEMU_FIRMWARE must be uefi or bios" >&2; exit 64;
}

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

common=(
  -m "${MEMORY}" -smp "${CPUS}" -boot d
  -drive "file=${ISO},media=cdrom,readonly=on"
  -netdev "user,id=net0,hostfwd=tcp::${SSH_PORT}-:22"
  -device virtio-net-pci,netdev=net0
  -device virtio-keyboard-pci -device virtio-tablet-pci
  -display "${DISPLAY_BACKEND}"
  -audiodev "${AUDIO_BACKEND},id=audio0"
)

case "${ARCH}" in
  amd64)
    command=(qemu-system-x86_64 -machine q35 -device virtio-vga
      -device ich9-intel-hda -device hda-duplex,audiodev=audio0 "${common[@]}")
    if [[ -r /dev/kvm && -w /dev/kvm ]]; then
      command+=( -enable-kvm -cpu host )
    else
      command+=( -cpu max )
    fi
    if [[ "${FIRMWARE}" == uefi ]]; then
      if [[ "$(uname -s)" == Darwin ]]; then
        default_code=/opt/homebrew/share/qemu/edk2-x86_64-code.fd
        default_vars=/opt/homebrew/share/qemu/edk2-i386-vars.fd
      else
        default_code=/usr/share/OVMF/OVMF_CODE.fd
        default_vars=/usr/share/OVMF/OVMF_VARS.fd
      fi
      code="${ELIZAOS_OVMF_CODE:-${default_code}}"
      vars="${ELIZAOS_OVMF_VARS:-${default_vars}}"
      cp "${vars}" "${tmp}/OVMF_VARS.fd"
      command+=( -drive "if=pflash,format=raw,readonly=on,file=${code}" -drive "if=pflash,format=raw,file=${tmp}/OVMF_VARS.fd" )
    fi
    ;;
  arm64)
    [[ "${FIRMWARE}" == uefi ]] || { echo "arm64 requires UEFI" >&2; exit 64; }
    code="${ELIZAOS_AAVMF_CODE:-/usr/share/AAVMF/AAVMF_CODE.fd}"
    vars="${ELIZAOS_AAVMF_VARS:-/usr/share/AAVMF/AAVMF_VARS.fd}"
    cp "${vars}" "${tmp}/AAVMF_VARS.fd"
    command=(qemu-system-aarch64 -machine virt -cpu cortex-a72 -device virtio-gpu-pci "${common[@]}"
      -drive "if=pflash,format=raw,readonly=on,file=${code}"
      -drive "if=pflash,format=raw,file=${tmp}/AAVMF_VARS.fd")
    ;;
  riscv64)
    [[ "${FIRMWARE}" == uefi ]] || { echo "riscv64 requires UEFI" >&2; exit 64; }
    code="${ELIZAOS_RISCV_CODE:-/usr/share/qemu/RISCV_VIRT_CODE.fd}"
    vars="${ELIZAOS_RISCV_VARS:-/usr/share/qemu/RISCV_VIRT_VARS.fd}"
    cp "${vars}" "${tmp}/RISCV_VIRT_VARS.fd"
    command=(qemu-system-riscv64 -machine virt -cpu rv64 -device virtio-gpu-pci "${common[@]}"
      -drive "if=pflash,format=raw,readonly=on,file=${code}"
      -drive "if=pflash,format=raw,file=${tmp}/RISCV_VIRT_VARS.fd")
    ;;
  *) echo "unsupported architecture: ${ARCH}" >&2; exit 64 ;;
esac

echo "booting ${ISO} (${ARCH}, ${FIRMWARE}); ssh localhost:${SSH_PORT}"
"${command[@]}"
