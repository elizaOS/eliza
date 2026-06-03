# RISC-V 64 cross toolchain on the macOS host

Probed: 2026-05-18 on Darwin arm64 (macOS, Apple Silicon).

## What is available

Installed via Homebrew (`/opt/homebrew/bin`):

| Tool | Version | Notes |
| --- | --- | --- |
| `riscv64-elf-gcc` | GCC 16.1.0 | Bare-metal (newlib / no libc), `-elf` target. |
| `riscv64-elf-binutils` | (formula) | ld, as, objdump, objcopy for `riscv64-elf`. |
| `qemu-system-riscv64` | QEMU 11.0.0 | Can boot `virt` and `sifive_u` boards. |

Run `scripts/toolchain/check_riscv64.sh` to re-probe; it is the canonical check.

## What is NOT available on darwin-arm64

- **`riscv64-linux-gnu-gcc` / `riscv64-unknown-linux-gnu-gcc` (glibc cross).**
  Homebrew does not package a glibc-targeted RV64 cross compiler for macOS,
  and `riscv-collab/riscv-gnu-toolchain` does not publish darwin-arm64
  prebuilt tarballs (only x86_64-linux as of this writing). Building from
  source takes hours and is out of scope for this work order.

## Implications for downstream agents

| Stage | Buildable on host? |
| --- | --- |
| OpenSBI (M-mode firmware) | YES — uses `riscv64-elf-gcc`, fully freestanding. |
| U-Boot SPL / U-Boot proper (no-OS) | YES — `CROSS_COMPILE=riscv64-elf-`. |
| Linux kernel `vmlinux` / `Image` | YES — kernel build is freestanding and accepts the `-elf` toolchain (`ARCH=riscv CROSS_COMPILE=riscv64-elf-`). |
| Busybox / glibc / userspace initramfs | NO on host. Must be cross-built inside a Linux container (e.g. Debian `crossbuild-essential-riscv64`) or via Buildroot/Yocto in a Linux VM. |

Once kernel + OpenSBI artifacts exist, `qemu-system-riscv64 -machine virt` can
boot them with a pre-built initramfs supplied separately.

## Activation for downstream agents

No special activation needed — Homebrew tools are already on `PATH`. Set:

```sh
export CROSS_COMPILE=riscv64-elf-
export ARCH=riscv
```

For kernel builds that insist on the `linux-gnu` triplet, symlink or pass
`CROSS_COMPILE=riscv64-elf-` explicitly — the kernel does not require the
`linux-gnu` suffix.

## Host Userspace Build Follow-ups

1. Use a Linux container (Docker or OrbStack) with `apt install
   crossbuild-essential-riscv64` — adds glibc cross in seconds. Out of
   scope for this work order (no container runtime mandate).
2. Buildroot run inside a Linux VM produces a self-contained rootfs +
   kernel + bootloader.
3. Track `riscv-collab/riscv-gnu-toolchain` releases for an eventual
   darwin-arm64 prebuilt.
