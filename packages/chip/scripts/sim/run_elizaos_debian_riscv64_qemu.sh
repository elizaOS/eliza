#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build/boot the packages/os/linux Debian riscv64 fork through the chip-team
# emulator path. This delegates to the variant-local Makefile so the chip
# package consumes the same ISO build, QEMU boot harness, transcript capture,
# and evidence schema as the OS release gate.
set -euo pipefail

CHIP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "${CHIP_ROOT}/../.." && pwd)"
VARIANT="${REPO_ROOT}/packages/os/linux/variants/elizaos-debian-riscv64"
OUT="${ELIZAOS_RISCV64_OUT:-${VARIANT}/out}"
EVIDENCE="${ELIZAOS_RISCV64_EVIDENCE:-${VARIANT}/evidence/qemu_virt_boot.json}"
TRANSCRIPT="${ELIZAOS_RISCV64_TRANSCRIPT:-${VARIANT}/evidence/qemu_virt_boot.transcript.log}"
ISO="${ELIZAOS_RISCV64_ISO:-}"

mkdir -p "${OUT}"

if [ -z "${ISO}" ]; then
    make -C "${VARIANT}" build OUT_DIR="${OUT}"
    ISO="$(
        find "${OUT}" -maxdepth 1 -type f -name 'elizaos-debian-riscv64-*.iso' -printf '%T@ %p\n' |
            sort -nr |
            head -n 1 |
            cut -d' ' -f2-
    )"
fi

if [ -z "${ISO}" ] || [ ! -f "${ISO}" ]; then
    echo "ERROR: no elizaOS Debian riscv64 ISO found; set ELIZAOS_RISCV64_ISO=/path/to.iso or allow the build target to produce one" >&2
    exit 2
fi

make -C "${VARIANT}" qemu-virt-boot \
    ISO="${ISO}" \
    EVIDENCE="${EVIDENCE}" \
    TRANSCRIPT="${TRANSCRIPT}" \
    OUT_DIR="${OUT}"
