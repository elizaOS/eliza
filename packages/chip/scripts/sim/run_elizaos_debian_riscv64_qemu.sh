#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build/boot the packages/os/linux unified Debian build (ARCH=riscv64) through
# the chip-team emulator path. This delegates to the unified Makefile so the
# chip package consumes the same ISO build, QEMU boot harness, transcript
# capture, and evidence schema as the OS release gate.
set -euo pipefail

CHIP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "${CHIP_ROOT}/../.." && pwd)"
VARIANT="${REPO_ROOT}/packages/os/linux/elizaos"
OUT="${ELIZAOS_RISCV64_OUT:-${VARIANT}/out}"
EVIDENCE="${ELIZAOS_RISCV64_EVIDENCE:-${VARIANT}/evidence/qemu_virt_boot.json}"
TRANSCRIPT="${ELIZAOS_RISCV64_TRANSCRIPT:-${VARIANT}/evidence/qemu_virt_boot.transcript.log}"
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

make -C "${VARIANT}" qemu-boot ARCH=riscv64 \
    ISO="${ISO}" \
    EVIDENCE="${EVIDENCE}" \
    TRANSCRIPT="${TRANSCRIPT}"
