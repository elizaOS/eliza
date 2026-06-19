# Tier 2: Linux + Busybox boot on `qemu-system-riscv64 -M virt`

Canonical "smallest Linux that reaches a shell" recipe for the Eliza e1
chip. Tier 2 is purely a software milestone (QEMU `virt` machine, OpenSBI
default firmware, busybox initramfs). Tier 3 (Renode) and Tier 4 (Verilator)
will reuse the same kernel `Image` and initramfs with our SoC memory map
(`sw/linux/dts/eliza-e1-qemu.dts`).

## Status (2026-05-18)

- Branch: `ws/boot-tier2-linux-busybox` (from `develop`).
- Scaffolding in place:
  - `scripts/build/build_initramfs.sh`
  - `scripts/sim/run_qemu_tier2.sh`
  - `scripts/sim/run_qemu_tier2_check.py` (30s timeout, asserts banner + prompt)
  - `sw/linux/configs/eliza_tier2_qemu_defconfig`
  - `sw/linux/dts/eliza-e1-qemu.dts` (for Renode/Verilator)
- **Build blocked on macOS host (this machine)**: only the bare-metal
  `riscv64-elf-*` (newlib) toolchain is installed via Homebrew. The Linux
  kernel and a glibc-static busybox require `riscv64-linux-gnu-gcc`
  (glibc-targeted) which Homebrew does not ship.
- QEMU is available: `/opt/homebrew/bin/qemu-system-riscv64`.
- Linux source clone was **not attempted** (~1.3 GB, would not be usable on
  this host without the toolchain anyway). Documented for replay below.

### To unblock on macOS

```sh
# Option A: Docker (recommended)
docker run --rm -it -v "$PWD":/work -w /work ubuntu:24.04 bash -lc '
  apt-get update &&
  apt-get install -y gcc-riscv64-linux-gnu make bc bison flex \
    libssl-dev libelf-dev cpio gzip fakeroot git &&
  bash'

# Option B: official riscv-gnu-toolchain (slow, ~1h)
git clone --recursive https://github.com/riscv-collab/riscv-gnu-toolchain
cd riscv-gnu-toolchain
./configure --prefix=/opt/riscv --enable-linux
make linux -j"$(sysctl -n hw.ncpu)"
export PATH=/opt/riscv/bin:$PATH   # provides riscv64-unknown-linux-gnu-*
# (then substitute CROSS_COMPILE=riscv64-unknown-linux-gnu- below)
```

On Linux: `sudo apt-get install -y gcc-riscv64-linux-gnu` is sufficient.

## Step 1: Source acquisition

```sh
git clone --depth 1 --branch v6.6 https://github.com/torvalds/linux external/linux
git clone --depth 1 --branch 1_36_stable https://github.com/mirror/busybox external/busybox
```

Both ignored via existing `external/` entry in `.gitignore`.

## Step 2: Kernel config + build

```sh
cd external/linux
make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- defconfig
./scripts/kconfig/merge_config.sh -m .config \
    ../../sw/linux/configs/eliza_tier2_qemu_defconfig
make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- olddefconfig
make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- -j"$(nproc)" Image
ls -lh arch/riscv/boot/Image
# Expected: 3-5 MiB.
```

## Step 3: Busybox build (static)

```sh
cd external/busybox
make defconfig
sed -i 's/# CONFIG_STATIC is not set/CONFIG_STATIC=y/' .config
make CROSS_COMPILE=riscv64-linux-gnu- -j"$(nproc)"
file busybox
# Expected: ELF 64-bit LSB executable, UCB RISC-V, statically linked, ~900 KiB.
```

## Step 4: Initramfs

```sh
# From repo root:
bash scripts/build/build_initramfs.sh external/busybox/busybox
ls -lh build/initramfs/eliza_tier2.cpio.gz
# Expected: ~600 KiB - 1.1 MiB.
```

The script creates `/init`, `/bin/sh -> /bin/busybox`, mounts proc/sys/devtmpfs,
prints `eliza tier2: linux booted`, then execs `/bin/sh`.

## Step 5: Boot

```sh
# Interactive:
bash scripts/sim/run_qemu_tier2.sh

# Automated check (30s timeout, asserts banner + "/ #" prompt):
python3 scripts/sim/run_qemu_tier2_check.py
# Log: build/sim/qemu/tier2_linux.log
```

Expected console (abbreviated):

```
OpenSBI v1.x
...
Linux version 6.6.0 (... riscv64-linux-gnu-gcc ...)
...
Run /init as init process
eliza tier2: linux booted
/ #
```

## Step 6: Port to OUR memory map (Renode / Verilator)

QEMU `-machine virt` hard-codes UART at `0x10000000`. Our SoC uses
`0x10001000`. For Tier 3+:

1. Build a DTB from our overlay:
   ```sh
   mkdir -p build/dts
   dtc -I dts -O dtb -o build/dts/eliza-e1-qemu.dtb \
       sw/linux/dts/eliza-e1-qemu.dts
   ```
2. Pass `-dtb build/dts/eliza-e1-qemu.dtb` to QEMU (or load from
   Renode `.resc` / Verilator bootrom).
3. Kernel config keeps `CONFIG_OF=y` and does not embed a built-in DTB so the
   externally-supplied tree wins.
4. Confirm via `earlycon=ns16550a,mmio,0x10001000` on the cmdline.

CLINT (`0x02000000`) and PLIC (`0x0c000000`) bases already match QEMU virt;
only the UART moves. If our final SoC relocates CLINT/PLIC, update both this
DTS and `sw/opensbi/` platform fragments.

## Replay cheat-sheet

```sh
# After toolchain + sources are in place, from repo root:
( cd external/linux && \
  make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- defconfig && \
  ./scripts/kconfig/merge_config.sh -m .config ../../sw/linux/configs/eliza_tier2_qemu_defconfig && \
  make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- olddefconfig && \
  make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- -j"$(nproc)" Image )

( cd external/busybox && \
  make defconfig && \
  sed -i 's/# CONFIG_STATIC is not set/CONFIG_STATIC=y/' .config && \
  make CROSS_COMPILE=riscv64-linux-gnu- -j"$(nproc)" )

bash scripts/build/build_initramfs.sh
python3 scripts/sim/run_qemu_tier2_check.py
```
