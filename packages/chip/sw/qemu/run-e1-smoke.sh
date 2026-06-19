#!/usr/bin/env bash
#
# Boot Linux on the functional Eliza E1 NPU QEMU model and run one of the e1
# software-BSP smoke binaries against the real /dev/e1-npu device.
#
# The NPU is the `eliza.e1-npu` MMIO device model added to QEMU's `virt`
# machine (external/qemu-src/hw/misc/eliza_e1_npu.c, enabled with
# `-machine virt,e1-npu=on` at 0x10020000). It executes the real INT8/INT4
# GEMM, scalar, packed-dot and vector-ReLU arithmetic of rtl/npu/e1_npu.sv, so
# the GEMM_S8 smoke output is computed by a working model, not fabricated.
#
# Usage:
#   run-e1-smoke.sh mmio        # runs /usr/bin/e1-mmio-smoke
#   run-e1-smoke.sh ml          # runs /usr/bin/e1-npu-ml-smoke (gemm_s8_int8_2x2x3)
#
# The chosen smoke's guest stdout is emitted to this script's stdout and the
# script exits with the smoke's exit code, so the capture-evidence wrappers
# (sw/buildroot/scripts/capture-buildroot-evidence.sh,
#  sw/linux/scripts/capture-linux-bsp-evidence.sh) can frame it with the
# required eliza-evidence markers.
#
# Required artifacts (built by sw/qemu/build-e1-qemu-stack.sh):
#   E1_QEMU       qemu-system-riscv64 with the e1-npu device
#   E1_KERNEL     RISC-V Linux Image with the eliza,e1-npu/dma drivers built in
#   E1_INITRD     initramfs cpio.gz containing the smoke binaries + a runner
#
# SPDX-License-Identifier: GPL-2.0-or-later
set -euo pipefail

mode=${1:-}
case "$mode" in
    mmio|ml) ;;
    *) echo "usage: $0 mmio|ml" >&2; exit 2 ;;
esac

repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)

E1_QEMU=${E1_QEMU:-$repo_root/external/qemu-src/build/qemu-system-riscv64}
E1_KERNEL=${E1_KERNEL:-$repo_root/external/buildroot-2024.11/output/build/linux-6.12.90/arch/riscv/boot/Image}
E1_INITRD=${E1_INITRD:-$repo_root/external/buildroot-2024.11/output/images/rootfs-e1.cpio.gz}
E1_TIMEOUT=${E1_TIMEOUT:-120}

for f in "$E1_QEMU" "$E1_KERNEL" "$E1_INITRD"; do
    if [ ! -f "$f" ]; then
        echo "error: missing required artifact $f; run sw/qemu/build-e1-qemu-stack.sh" >&2
        exit 2
    fi
done

serial_log=$(mktemp)
trap 'rm -f "$serial_log"' EXIT

# Select which smoke the guest init runs. The guest init writes a clean
# delimiter and the smoke exit code so we can extract exactly the smoke output.
timeout "$E1_TIMEOUT" "$E1_QEMU" \
    -M virt,e1-npu=on -bios default -nographic \
    -kernel "$E1_KERNEL" -initrd "$E1_INITRD" \
    -append "console=ttyS0 earlycon e1smoke=$mode" \
    > "$serial_log" 2>&1 || true

# Extract the section the guest init framed for this smoke.
if ! grep -q "E1_SMOKE_BEGIN" "$serial_log"; then
    echo "error: guest did not reach the e1 smoke runner; serial tail:" >&2
    tail -20 "$serial_log" >&2
    exit 1
fi

sed -n '/E1_SMOKE_BEGIN/,/E1_SMOKE_END/p' "$serial_log" \
    | grep -v -e 'E1_SMOKE_BEGIN' -e 'E1_SMOKE_END' -e 'E1_SMOKE_RC='

rc=$(sed -n 's/^E1_SMOKE_RC=\([0-9][0-9]*\).*/\1/p' "$serial_log" | head -1)
if [ -z "$rc" ]; then
    echo "error: guest did not report an e1 smoke exit code" >&2
    exit 1
fi
exit "$rc"
