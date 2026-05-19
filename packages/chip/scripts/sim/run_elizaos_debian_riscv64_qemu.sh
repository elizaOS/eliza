#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build/boot the packages/os/linux Debian riscv64 fork through the chip-team
# emulator path. This is the software-visible e1 bring-up gate: QEMU virt
# supplies the RISC-V CPU/SBI platform while the artifacts are produced by the
# elizaOS Debian riscv64 variant and can later be handed to Renode/Verilator.
set -euo pipefail

CHIP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "${CHIP_ROOT}/../.." && pwd)"
VARIANT="${REPO_ROOT}/packages/os/linux/variants/elizaos-debian-riscv64"
OUT="${ELIZAOS_RISCV64_OUT:-${VARIANT}/out}"
IMAGE_TAG="${ELIZAOS_RISCV64_BUILDER_IMAGE:-elizaos-debian-riscv64-builder}"

mkdir -p "${OUT}"

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is required for the containerized riscv64 Debian build/smoke" >&2
    exit 2
fi

docker build -t "${IMAGE_TAG}" "${VARIANT}"
docker run --rm --privileged \
    -v "${VARIANT}:/build" \
    -v "${OUT}:/out" \
    -e ELIZAOS_OUT_DIR=/out \
    "${IMAGE_TAG}"
docker run --rm --entrypoint /scripts/qemu-smoke.py \
    -v "${OUT}:/out" \
    -v "${VARIANT}/scripts:/scripts:ro" \
    "${IMAGE_TAG}" \
    --out-dir /out --log /out/qemu-smoke.log
