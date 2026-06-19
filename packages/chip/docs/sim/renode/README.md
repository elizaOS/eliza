# Renode qemu-virt reference target

Renode is a qemu-virt software reference only tier. The checked-in reference by
itself is not boot evidence for the qemu-virt path and is not the e1-chip
hardware ABI. In short, this is not the e1-chip hardware ABI.

The platform in this directory mirrors enough of the qemu-virt reference shape
for early firmware bring-up experiments: an RV64 CPU, RAM at `0x8000_0000`, and
a UART at `0x1000_0000`. The e1-chip ABI remains the CPU-less debug/MMIO
contract in `sw/platform/e1_platform_contract.json`; the overlapping
`0x1000_0000` qemu-virt UART address must not be treated as the e1
peripheral-control block in software that targets real hardware.

`scripts/run_renode.sh --check` is fail-closed. It checks that the platform,
documentation, and `sim/renode/expected_serial_banner.txt` match the qemu-virt
contract, then runs the executable preflight. Missing `renode` or missing
`build/qemu/e1_qemu_firmware.elf` reports `STATUS: BLOCKED` unless
`REQUIRE_RENODE=1` is set. When both are present, check mode runs Renode for a
bounded interval and only passes if the captured output contains the expected
serial banner. Install Renode from the official packages, confirm the executable
and version, then run:

```sh
command -v renode
renode --version
scripts/run_qemu.sh --build-firmware
make renode-check
```

Manual transcript intake is explicit:

```sh
scripts/run_renode.sh --check --transcript path/to/real-renode-serial.log
```

Transcript intake also runs the local Renode preflight and checks for
`build/qemu/e1_qemu_firmware.elf`. A copied banner in a text file is not
enough on its own: if `renode` is missing, `renode --version` cannot run, or the
firmware ELF is absent, intake remains `STATUS: BLOCKED`.

The expected UART banner contract is:
`scripts/run_renode.sh --check` is fail-closed. It checks that the platform and
documentation match the qemu-virt contract, then reports executable smoke as
`STATUS: BLOCKED` unless a real Renode serial transcript path exists. The
expected UART transcript artifact is
`build/renode/eliza_e1_uart.transcript`, the expected smoke manifest
artifact is `build/renode/eliza_e1_smoke.json`, and the QEMU reference
transcript artifact is `build/reports/qemu_smoke.log`. A future passing smoke
must load `build/qemu/e1_qemu_firmware.elf` and capture the UART banner:

```text
eliza e1 qemu
```

Passing bounded check or intake archives `build/reports/renode_smoke.log` and
`build/reports/renode_smoke.manifest`. A failed bounded run writes
`build/reports/renode_smoke_attempt.log` but does not create passing evidence.
The manifest is validated before `renode.run` can pass and must identify the
evidence as `renode-executable-transcript`, bind it to the archived transcript
hash, bind it to the firmware hash, record the Renode executable/version
preflight, point at the banner contract, and repeat the required banner. Until a
real transcript is captured by Renode or ingested from a real Renode serial run,
Renode status may be described only as reference-only or blocked, not booted.
Until that transcript is automated and checked in, Renode status may be
described only as reference-only or blocked, not booted.
