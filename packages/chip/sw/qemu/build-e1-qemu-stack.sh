#!/usr/bin/env bash
#
# Build the functional Eliza E1 NPU QEMU stack used by sw/qemu/run-e1-smoke.sh
# to produce REAL software-BSP smoke evidence:
#
#   1. qemu-system-riscv64 with the eliza.e1-npu MMIO device model
#      (external/qemu-src/hw/misc/eliza_e1_npu.c, mapped at 0x10020000 on the
#      `virt` machine via `-machine virt,e1-npu=on`). The model executes the
#      real GEMM_S8/GEMM_S4/scalar/packed-dot/VRELU arithmetic of
#      rtl/npu/e1_npu.sv and the descriptor ring with guest-memory DMA.
#
#   2. A RISC-V Linux Image (buildroot kernel 6.12.90) with the e1 NPU/DMA
#      contract drivers (sw/linux/drivers/e1/{e1-npu,e1-dma}.c) built in, so
#      /dev/e1-npu exposes the GEMM_S8 ioctl, plus CONFIG_SERIAL_OF_PLATFORM so
#      the DT-described UART comes up as the console.
#
#   3. An initramfs containing the e1-mmio-smoke and e1-npu-ml-smoke binaries
#      (built statically from sw/buildroot/package/.../src) plus an init that
#      runs the smoke selected by the `e1smoke=` kernel argument.
#
# This is a host-build helper; it operates on the gitignored external/ trees.
#
# SPDX-License-Identifier: GPL-2.0-or-later
set -euo pipefail

repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"
# shellcheck disable=SC1091
. tools/env.sh 2>/dev/null || true

QEMU_SRC=external/qemu-src
LINUXDIR=external/buildroot-2024.11/output/build/linux-6.12.90
BR_HOST=external/buildroot-2024.11/output/host
IMAGES=external/buildroot-2024.11/output/images
CROSS=riscv64-buildroot-linux-gnu-
export PATH="$repo_root/$BR_HOST/bin:$PATH"

echo "[1/4] building qemu-system-riscv64 with eliza.e1-npu device"
# Install the tracked device model and virt-machine integration into the
# (gitignored) QEMU source tree if not already present.
cp sw/qemu/qemu-device/eliza_e1_npu.c "$QEMU_SRC/hw/misc/eliza_e1_npu.c"
cp sw/qemu/qemu-device/eliza_e1_npu.h "$QEMU_SRC/include/hw/misc/eliza_e1_npu.h"
if ! grep -qF 'CONFIG_ELIZA_E1_NPU' "$QEMU_SRC/hw/misc/meson.build"; then
    ( cd "$QEMU_SRC" && git apply sw/qemu/../../sw/qemu/qemu-device/virt-e1-npu-integration.patch 2>/dev/null ) || \
    ( cd "$QEMU_SRC" && patch -p1 < "$repo_root/sw/qemu/qemu-device/virt-e1-npu-integration.patch" )
fi
rm -f "$QEMU_SRC/build/riscv64-softmmu-config-devices.mak"
"$QEMU_SRC/build/pyvenv/bin/meson" setup --reconfigure "$QEMU_SRC/build" >/dev/null 2>&1 || true
ninja -C "$QEMU_SRC/build" qemu-system-riscv64

echo "[2/4] building Linux Image with e1 contract drivers"
contract_dir="$LINUXDIR/drivers/misc/eliza-e1-contract"
mkdir -p "$contract_dir"
cp sw/linux/drivers/e1/e1-npu-uapi.h sw/linux/drivers/e1/e1_platform_contract.h "$contract_dir/"
# Import the e1 NPU/DMA drivers, adapting the two 6.12 API points (void-return
# platform_driver.remove, removed no_llseek) without touching the repo source.
sed -e 's/^\t\.llseek = no_llseek,$//' \
    -e 's/^static int e1_npu_remove/static void e1_npu_remove/' \
    -e '/^static void e1_npu_remove/,/^}/ s/^\treturn 0;$//' \
    sw/linux/drivers/e1/e1-npu.c > "$contract_dir/e1-npu.c"
sed -e 's/^static int e1_dma_remove/static void e1_dma_remove/' \
    -e '/^static void e1_dma_remove/,/^}/ s/^\treturn 0;$//' \
    sw/linux/drivers/e1/e1-dma.c > "$contract_dir/e1-dma.c"
cat > "$contract_dir/Kconfig" <<'KCFG'
config ELIZA_E1_CONTRACT
	bool "Eliza e1 NPU/DMA contract drivers"
	depends on OF
	default y
	help
	  Built-in Eliza e1 NPU (/dev/e1-npu, GEMM_S8 ioctl) and DMA contract
	  platform drivers, bound to compatible "eliza,e1-npu"/"eliza,e1-dma".
KCFG
cat > "$contract_dir/Makefile" <<'MK'
obj-$(CONFIG_ELIZA_E1_CONTRACT) += e1-npu.o
obj-$(CONFIG_ELIZA_E1_CONTRACT) += e1-dma.o
ccflags-y += -I$(src)
MK
grep -qF 'eliza-e1-contract/Kconfig' "$LINUXDIR/drivers/misc/Kconfig" || \
    sed -i 's#^endmenu#source "drivers/misc/eliza-e1-contract/Kconfig"\nendmenu#' \
        "$LINUXDIR/drivers/misc/Kconfig"
grep -qF 'eliza-e1-contract/' "$LINUXDIR/drivers/misc/Makefile" || \
    printf 'obj-y\t\t\t\t+= eliza-e1-contract/\n' >> "$LINUXDIR/drivers/misc/Makefile"
grep -qx 'CONFIG_ELIZA_E1_CONTRACT=y' "$LINUXDIR/.config" || \
    echo 'CONFIG_ELIZA_E1_CONTRACT=y' >> "$LINUXDIR/.config"
# The DT UART node is only probed as the console with SERIAL_OF_PLATFORM.
grep -qx 'CONFIG_SERIAL_OF_PLATFORM=y' "$LINUXDIR/.config" || \
    echo 'CONFIG_SERIAL_OF_PLATFORM=y' >> "$LINUXDIR/.config"
make -C "$LINUXDIR" ARCH=riscv CROSS_COMPILE="$CROSS" olddefconfig >/dev/null
make -C "$LINUXDIR" ARCH=riscv CROSS_COMPILE="$CROSS" -j"$(nproc)" Image

echo "[3/4] building smoke binaries"
bin=$(mktemp -d)
"${CROSS}gcc" -Wall -O2 -static \
    -o "$bin/e1-mmio-smoke" sw/buildroot/package/e1-mmio-smoke/src/e1-mmio-smoke.c
"${CROSS}gcc" -Wall -Wextra -O2 -static \
    -I sw/linux/drivers/e1 \
    -o "$bin/e1-npu-ml-smoke" sw/buildroot/package/e1-npu-ml-smoke/src/e1-npu-ml-smoke.c

echo "[4/4] assembling initramfs"
rootdir=$(mktemp -d)
( cd "$rootdir" && zcat "$repo_root/$IMAGES/rootfs.cpio.gz" | cpio -idm 2>/dev/null ) || true
install -D -m 0755 "$bin/e1-mmio-smoke" "$rootdir/usr/bin/e1-mmio-smoke"
install -D -m 0755 "$bin/e1-npu-ml-smoke" "$rootdir/usr/bin/e1-npu-ml-smoke"
install -D -m 0755 sw/qemu/guest-init/S99e1smoke "$rootdir/etc/init.d/S99e1smoke"
# Build a root-owned cpio with the device nodes the kernel needs for an
# initramfs console (gen_init_cpio avoids needing host root / mknod).
list=$(mktemp)
python3 sw/qemu/gen-cpio-list.py "$rootdir" > "$list"
"$LINUXDIR/usr/gen_init_cpio" "$list" > "$IMAGES/rootfs-e1.cpio"
gzip -9 -f "$IMAGES/rootfs-e1.cpio"
rm -rf "$bin" "$rootdir" "$list"

echo "done:"
echo "  qemu    : $QEMU_SRC/build/qemu-system-riscv64"
echo "  kernel  : $LINUXDIR/arch/riscv/boot/Image"
echo "  initrd  : $IMAGES/rootfs-e1.cpio.gz"
