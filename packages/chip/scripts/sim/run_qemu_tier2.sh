#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Boot Linux + busybox initramfs under qemu-system-riscv64 -M virt.
# Tier 2 milestone: kernel reaches "/ #" busybox prompt with userspace banner.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KERNEL="${KERNEL:-${REPO_ROOT}/external/linux/arch/riscv/boot/Image}"
INITRD="${INITRD:-${REPO_ROOT}/build/initramfs/eliza_tier2.cpio.gz}"
LOG_DIR="${REPO_ROOT}/build/sim/qemu"
LOG="${LOG_DIR}/tier2_linux.log"

mkdir -p "${LOG_DIR}"

for f in "${KERNEL}" "${INITRD}"; do
  if [[ ! -f "${f}" ]]; then
    echo "ERROR: missing artifact: ${f}" >&2
    echo "See docs/sim/tier2-linux-busybox-recipe.md for build steps." >&2
    exit 1
  fi
done

exec qemu-system-riscv64 \
  -machine virt \
  -nographic \
  -m 256M -smp 1 \
  -bios default \
  -kernel "${KERNEL}" \
  -initrd "${INITRD}" \
  -append "console=ttyS0 earlycon=sbi panic=10" \
  -serial mon:stdio \
  2>&1 | tee "${LOG}"
