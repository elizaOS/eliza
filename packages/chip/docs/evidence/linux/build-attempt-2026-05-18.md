# BSP build attempt — 2026-05-18

Branch: `ws/bsp-evidence-attempt`
Host: macOS 15 (Darwin 25.2.0), arm64 (Apple Silicon)

## Goal

Satisfy the BLOCKED evidence markers under `docs/evidence/{linux,buildroot}/`
by actually building the external Linux kernel with the in-tree
`sw/linux/drivers/eliza/` drivers and a Buildroot rootfs.

## Outcome: NOT satisfied on this host

Build host lacks a RISC-V Linux glibc cross toolchain. Markers were left in
place (already well-formed for `scripts/check_kernel_bsp.py`) and reproduction
notes refined to spell out the host requirements and `CROSS_COMPILE`.

## Toolchain probe

```
$ command -v riscv64-linux-gnu-gcc riscv64-unknown-linux-gnu-gcc
# (no output, exit 1 — neither toolchain installed)

$ brew list | grep -i riscv
riscv64-elf-binutils
riscv64-elf-gcc            # bare-metal only; cannot link a Linux kernel
qemu-system-riscv64

$ brew search riscv-gnu-toolchain
# no formula
```

The only RISC-V compiler available via Homebrew on macOS arm64 is
`riscv64-elf-gcc` (bare-metal ELF target). Building a Linux kernel requires
`riscv64-linux-gnu-gcc` (or `riscv64-unknown-linux-gnu-gcc`) — a glibc/musl
Linux-target cross compiler. None is packaged for macOS arm64 in Homebrew,
and building one from source (riscv-gnu-toolchain `--enable-linux`) is a
multi-hour task that exceeds the 25-minute box for this attempt.

Linux kernel clone + Buildroot clone were also skipped, since without the
toolchain neither would produce evidence — they would just consume disk.

## What a Linux build host should run

Recommended host: Ubuntu 22.04+ (x86_64 or aarch64) with:

```
sudo apt install -y gcc-riscv64-linux-gnu build-essential bc bison flex \
    libssl-dev libelf-dev cpio python3-yaml device-tree-compiler
pip install dtschema

REPO=$PWD   # repo root containing sw/linux/

git clone --depth 1 --branch v6.6 https://github.com/torvalds/linux.git external/linux
cd external/linux

# Inject drivers
mkdir -p drivers/misc/eliza
cp -r "$REPO"/sw/linux/drivers/eliza/* drivers/misc/eliza/

# Inject DT bindings for dtbs_check
mkdir -p Documentation/devicetree/bindings/eliza
cp "$REPO"/sw/linux/Documentation/devicetree/bindings/eliza/*.yaml \
   Documentation/devicetree/bindings/eliza/

# Wire Kconfig/Makefile into drivers/misc
grep -q eliza drivers/misc/Kconfig || \
  sed -i '/^endmenu/i source "drivers/misc/eliza/Kconfig"' drivers/misc/Kconfig
grep -q eliza drivers/misc/Makefile || \
  echo 'obj-y += eliza/' >> drivers/misc/Makefile

# Base + fragment config
make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- defconfig
./scripts/kconfig/merge_config.sh -O . .config \
    "$REPO"/sw/linux/configs/eliza_e1.fragment

# Build
make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- -j"$(nproc)" 2>&1 | \
    tee "$REPO"/docs/evidence/linux/eliza_e1_kernel_build.log

# dtbs_check
make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- dtbs_check \
    DT_SCHEMA_FILES=Documentation/devicetree/bindings/eliza/ 2>&1 | \
    tee "$REPO"/docs/evidence/linux/eliza_e1_dtb_check.log
```

For Buildroot:

```
git clone --depth 1 --branch 2024.02 https://gitlab.com/buildroot.org/buildroot.git external/buildroot
cd external/buildroot
make BR2_EXTERNAL="$REPO"/sw/buildroot eliza_e1_defconfig 2>&1 | \
    tee "$REPO"/docs/evidence/buildroot/eliza_e1_defconfig.log
make -j"$(nproc)"
find output/images -maxdepth 1 -type f -print | \
    tee "$REPO"/docs/evidence/buildroot/eliza_e1_image_manifest.txt
```

Boot the produced image under `qemu-system-riscv64 -M virt` (or hardware /
FPGA) and run `e1-mmio-smoke` to capture the two `e1-mmio-smoke.log`
artifacts.

## Why no kernel checkout was committed

Per the work-order constraint and existing `.gitignore` (`external/`),
external kernel/Buildroot trees are never committed.

## BLOCKED marker status

All six markers under `docs/evidence/{linux,buildroot}/*.BLOCKED` conform
to the `check_kernel_bsp.py` gate (non-empty, first line begins with
`reason:`) and `python3 scripts/check_kernel_bsp.py` exits 0. They were not
modified destructively; only the reproduction hints were tightened where
the original `required:` line under-specified the host toolchain.
