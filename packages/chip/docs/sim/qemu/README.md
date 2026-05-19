# QEMU qemu-virt reference target

QEMU is the qemu-virt software reference only tier. It is not the e1-chip hardware ABI.

The e1 chip has no CPU and is driven through the package debug nibble bridge into the MMIO contract recorded in `sw/platform/e1_platform_contract.json`. By contrast, `make qemu` launches `qemu-system-riscv64 -machine virt` with RAM at `0x8000_0000` and a qemu-virt UART at `0x1000_0000`.

The checked-in qemu-virt firmware source is `sw/bootrom/e1_qemu_firmware.S`.
Build it with a local bare-metal RISC-V toolchain:

```sh
scripts/run_qemu.sh --build-firmware
```

That writes `build/qemu/e1_qemu_firmware.elf`. `scripts/run_qemu.sh`
launches that ELF by default. The compatibility alias
`scripts/run_qemu.sh --build-stub` is still accepted, but no checked-in ELF is
used as boot evidence.

`make qemu-check` runs semantic checks for the qemu-virt source, linker script,
and documentation. If `riscv64-unknown-elf-gcc`, `riscv64-elf-gcc`,
`riscv64-linux-gnu-gcc`, or `RISCV_CC` is available, it also builds the firmware
and runs a bounded QEMU smoke that expects the UART banner:

```text
eliza e1 qemu
```

On a passing executable smoke, the captured serial transcript is archived at
`build/reports/qemu_smoke.log`. A QEMU status report may be treated as executed
software-reference evidence only when both `STATUS: PASS qemu.check` and that
banner-bearing transcript are present.

Each stage prints an actionable `STATUS: PASS`, `STATUS: BLOCKED`, or
`STATUS: FAIL` line. If the RISC-V toolchain or QEMU is missing, the executable
smoke is explicitly reported as blocked after the semantic checks pass.
`make qemu-check` is the non-strict local status target used by `make smoke`.
`make qemu-check-strict` runs with `REQUIRE_QEMU=1`, so blocked executable smoke
returns nonzero. The project Docker image installs Ubuntu's
`gcc-riscv64-unknown-elf` package so strict QEMU can build a real RISC-V ELF
instead of relying on a checked-in binary.

The next software milestones should add:

```text
timer test
DMA/NPU/display MMIO smoke tests using the central contract
```

## Linux Payload Smoke

`scripts/run_qemu.sh --check-os` is a bounded qemu-virt Linux payload smoke. It
is not e1-chip hardware or generated AP evidence. The shortest prebuilt path
is Debian's riscv64 netboot installer kernel and initrd:

```sh
python3 scripts/fetch_qemu_linux_payload.py
scripts/run_qemu.sh --check-os
```

The fetch helper downloads Debian `linux`, `initrd.gz`, and `SHA256SUMS`, then
verifies the payload hashes before writing
`build/qemu/linux_payload/debian-installer-riscv64-20260517T000000Z/manifest.json`.
`--check-os` auto-discovers those files and archives the bounded QEMU output at
`build/reports/qemu_os_boot_attempt.log`. It also writes a structured status
manifest at `build/reports/qemu_os_boot_attempt.json` with the required claim
boundary:

```text
qemu_virt_reference_only_not_e1_chip_rtl
```

The default OS smoke memory is `2G` because the Debian riscv64 installer initrd
can panic with `No working init found` after initramfs unpacking fails on much
smaller RAM sizes. Override with `QEMU_OS_MEMORY=...` only when intentionally
testing the low-memory failure path.

Validate the payload manifest, boot transcript, and reference-only boundary
with:

```sh
python3 scripts/check_qemu_linux_payload_status.py
```

This path may prove that local QEMU can execute a real riscv64 Linux payload on
`-machine virt`; it still cannot be used as Eliza AP, OpenSBI/U-Boot chain,
BSP driver, or Android evidence.

The smallest next BSP import step is the external Linux BSP import preflight:

```sh
python3 scripts/check_bsp_next_import_step.py
LINUX_DIR=/path/to/linux python3 scripts/check_bsp_next_import_step.py
```

Linux comes before Buildroot because the Buildroot target needs a kernel
tree/tarball that already contains the Eliza Linux drivers and DTS. OpenSBI
and U-Boot remain blocked on a CPU-capable SoC handoff with RAM, UART, timer,
interrupt controller, and boot handoff.
