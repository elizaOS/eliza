#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build/boot the packages/os/linux unified Debian build (ARCH=riscv64) through
# the chip-team emulator path. This consumes the same ISO build and the same
# headless QEMU boot harness (scripts/qemu_virt_smoke.py) as the OS release
# gate, so the chip package shares the boot/transcript/evidence schema.
#
# Evidence isolation: this chip-side flow writes its own dedicated evidence
# file (evidence/qemu_virt_kernel_boot.json) rather than the OS release
# evidence (evidence/qemu_virt_boot.json). The release evidence is owned
# exclusively by the OS release flow; a chip-side boot run here can never
# clobber it, which keeps the os-rv64-release-check gate from flapping.
set -euo pipefail

CHIP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "${CHIP_ROOT}/../.." && pwd)"
VARIANT="${REPO_ROOT}/packages/os/linux/elizaos"
OUT="${ELIZAOS_RISCV64_OUT:-${VARIANT}/out}"
EVIDENCE="${ELIZAOS_RISCV64_EVIDENCE:-${VARIANT}/evidence/qemu_virt_kernel_boot.json}"
TRANSCRIPT="${ELIZAOS_RISCV64_TRANSCRIPT:-${VARIANT}/evidence/qemu_virt_kernel_boot.transcript.log}"
ISO="${ELIZAOS_RISCV64_ISO:-}"

mkdir -p "${OUT}"

if [ -z "${ISO}" ]; then
    make -C "${VARIANT}" build ARCH=riscv64
    ISO="$(
        find "${OUT}" -maxdepth 1 -type f -name 'elizaos-linux-riscv64-*.iso' -printf '%T@ %p\n' |
            sort -nr |
            head -n 1 |
            cut -d' ' -f2-
    )"
fi

if [ -z "${ISO}" ] || [ ! -f "${ISO}" ]; then
    echo "ERROR: no elizaOS Linux riscv64 ISO found; set ELIZAOS_RISCV64_ISO=/path/to.iso or allow the build target to produce one" >&2
    exit 2
fi
ISO="$(realpath "${ISO}")"

REPORT="${ELIZAOS_RISCV64_REPORT:-${CHIP_ROOT}/build/reports/qemu_virt_kernel_boot.json}"
mkdir -p "$(dirname "${REPORT}")"

python3 "${VARIANT}/scripts/qemu_virt_smoke.py" \
    --iso "${ISO}" \
    --evidence "${EVIDENCE}" \
    --transcript "${TRANSCRIPT}" \
    --report "${REPORT}"
