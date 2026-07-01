# Boot Tiers 0 & 1 — QEMU virt bring-up progress

Branch: `ws/boot-tier0-1`

## Status (2026-05-18)

| Tier | Artifact | Built? | Booted? |
|------|----------|--------|---------|
| 0    | `fw/bare-metal/e1/e1.elf` — bare-metal "E1\n" via 16550 UART @ 0x10000000 | NO — blocked on RV64 toolchain | NO |
| 1    | OpenSBI generic `fw_payload.elf` wrapping `fw/opensbi-payloads/e1-smode/e1.bin` | NO — blocked on RV64 toolchain | NO |

`qemu-system-riscv64` is installed (Homebrew, at `/opt/homebrew/bin/qemu-system-riscv64`).
`gtimeout` is installed. The blocker is a RISC-V cross-compiler — neither
`riscv64-unknown-elf-gcc` nor `riscv64-linux-gnu-gcc` is on PATH. A separate agent
(`ws/toolchain-riscv64`) is provisioning the toolchain.

## Files scaffolded on this branch

```
fw/bare-metal/e1/{reset.S, e1.c, linker.ld, Makefile}
fw/opensbi-payloads/e1-smode/{reset.S, e1.c, linker.ld, Makefile}
scripts/sim/run_qemu_baremetal.sh        # tier 0 boot + log + assert E1
scripts/build/build_opensbi_qemu.sh      # clones opensbi v1.4, builds fw_payload
scripts/sim/run_qemu_opensbi.sh          # tier 1 boot + assert banner + payload string
docs/sim/boot-tiers-progress.md          # this file
```

## Design notes

- **UART address.** Tier 0 and Tier 1 target the **QEMU virt** UART at
  `0x10000000` (16550A) so they validate on a stock machine. Our project
  platform contract (`sw/platform/e1_platform_contract.json`) places the
  UART at `0x10001000`; later tiers will use a custom machine or DTS overlay
  to relocate to that address. This is intentional and documented in the C
  source headers.
- **Link addresses.** Tier 0 ELF at `0x80000000` (QEMU `-kernel` default for
  RV64 virt). Tier 1 payload at `0x80200000` (OpenSBI generic S-mode jump
  target — `FW_TEXT_START` 0x80000000 + 2 MiB).
- **Reset.S** parks secondary harts on `wfi`, sets sp on hart 0, calls
  `main()`. After `uart_puts(...)`, `main()` enters a `wfi` loop.
- **Compiler flags.** `-nostdlib -nostartfiles -ffreestanding -mcmodel=medany
  -march=rv64imac -mabi=lp64 -O2`.
- **No SBI console use in Tier 1.** The S-mode payload pokes the 16550
  directly so the test does not depend on SBI extensions being negotiated.
  OpenSBI's PMP defaults allow S-mode UART access on virt.

## Exact reproduction once the toolchain lands

Assuming `riscv64-unknown-elf-gcc` is on PATH (otherwise pass
`CROSS=riscv64-linux-gnu-` / `CROSS_COMPILE=riscv64-linux-gnu-`):

```bash
# --- Tier 0 ---
make -C fw/bare-metal/e1
scripts/sim/run_qemu_baremetal.sh
# Expected: build/sim/qemu/tier0_baremetal.log contains "E1"

# --- Tier 1 ---
make -C fw/opensbi-payloads/e1-smode
scripts/build/build_opensbi_qemu.sh
scripts/sim/run_qemu_opensbi.sh
# Expected: build/sim/qemu/tier1_opensbi.log contains the OpenSBI banner
# and "E1 from S-mode"
```

## Manual one-liners (no helper scripts)

```bash
# Tier 0
qemu-system-riscv64 -machine virt -nographic -bios none \
  -kernel fw/bare-metal/e1/e1.elf \
  -monitor none -serial mon:stdio -no-reboot

# Tier 1
qemu-system-riscv64 -machine virt -nographic \
  -bios external/opensbi/build/platform/generic/firmware/fw_payload.elf \
  -monitor none -serial mon:stdio -no-reboot
```

Exit QEMU with `Ctrl-A x`.

## Verification attempted on this branch

```
$ which riscv64-unknown-elf-gcc riscv64-linux-gnu-gcc
riscv64-unknown-elf-gcc not found
riscv64-linux-gnu-gcc not found
$ which qemu-system-riscv64 gtimeout
/opt/homebrew/bin/qemu-system-riscv64
/opt/homebrew/bin/gtimeout
```

`make -C fw/bare-metal/e1` was not attempted because no cross compiler
is available; the Makefile would fail with `command not found`.

## Top-level Makefile targets (ws/makefile-tier2)

The boot pipeline is wired into the root `Makefile` so developers can drive each
tier with a single command:

| Target                | What it proves                                                                     |
|-----------------------|------------------------------------------------------------------------------------|
| `make tier0`          | Builds `fw/bare-metal/e1` and boots it under QEMU virt; PASS if `E1` is seen on the serial log. |
| `make tier1`          | Builds OpenSBI `fw_payload.elf` wrapping the S-mode e1 and boots it; PASS if OpenSBI banner + payload string both appear. Exits 2 on macOS (binutils `-pie` blocker — see `docs/sim/tier1-opensbi-macos-blocker.md`). |
| `make tier2-build`    | Invokes `scripts/build/docker_build_tier2.sh` to produce `build/sim/tier2/Image` and `build/initramfs/eliza_tier2.cpio.gz`. Requires a running Docker daemon. |
| `make tier2-boot`     | Boots the Tier 2 kernel + initramfs via `scripts/sim/run_qemu_tier2_check.py`; PASS if the busybox userspace banner and `/ #` prompt are both seen within 30 s. |
| `make tier2`          | `tier2-build` then `tier2-boot`.                                                   |
| `make boot-pipeline-status` | Prints one line per tier with `READY` / `BLOCKED` / `MISSING` based on artifact presence and host capability. Non-destructive — does not build anything. |
