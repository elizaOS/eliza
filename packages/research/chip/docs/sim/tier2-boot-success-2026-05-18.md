# Tier 2 Linux boot success — 2026-05-18

Booted Linux 6.6 riscv64 + static busybox 1.36 initramfs on `qemu-system-riscv64
-machine virt` using QEMU's bundled OpenSBI v1.7, landing in a `~ #` shell.

## Artifacts

- Kernel: `build/sim/tier2/Image` (22 MiB; linux v6.6 `make ARCH=riscv defconfig Image`)
- Busybox: `build/sim/tier2/busybox` (1.7 MiB; busybox 1_36_stable static, SHA1/256 hwaccel disabled to avoid x86-NI assumption)
- Initramfs: `build/sim/tier2/initramfs.cpio.gz` (1.2 MiB)
- Transcript: `build/sim/qemu/tier2_linux.log`

## Repro

```sh
# 1. Build kernel + busybox + initramfs inside the riscv64 cross container
make tier2-build       # invokes scripts/build/docker_build_tier2.sh

# 2. Boot to shell with bundled OpenSBI
make tier2-boot        # invokes scripts/sim/run_qemu_tier2_check.py
```

## Boot log excerpt

```
[    0.961912] Run /init as init process

===============================
eliza tier2: linux booted
===============================
Linux (none) 6.6.0-dirty #1 SMP Tue May 19 02:08:44 UTC 2026 riscv64 GNU/Linux
~ #
```

## Notes

- macOS arm64 host; Docker Desktop running an amd64 Debian bookworm-slim
  container with `gcc-riscv64-linux-gnu` + `libc6-dev-riscv64-cross` + `bzip2`.
- QEMU `-bios default` uses OpenSBI v1.7 bundled with qemu-system-riscv64 11.0.0
  (avoids the bare-elf binutils `-pie` blocker described in
  `docs/sim/tier1-opensbi-macos-blocker.md`).
- Address map is QEMU virt's default (UART 0x10000000). The follow-up Renode
  step (`sim/renode/eliza_e1.repl`) rebinds to our platform contract
  addresses (UART 0x10001000, CLINT 0x02000000, PLIC 0x0C000000).
- This is the **software** Tier 2 milestone. The **hardware** Tier 4 milestone
  is booting this same Image+initramfs on the Verilator-compiled
  ElizaRocketConfig Rocket simulator inside our SoC top-level wrapper —
  blocked on Linux x86_64 build host for Chipyard (see
  `docs/sim/verilator-rocket-bootstrap-status.md`).
