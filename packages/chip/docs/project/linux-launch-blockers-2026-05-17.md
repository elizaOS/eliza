# Linux launch blockers

Date: 2026-05-17

Scope: current repository state for launching Linux on the selected Eliza
CPU/AP path.

## Current executable evidence

The repo can execute bounded firmware smoke paths, but it cannot boot Linux yet.

- `python3 scripts/run_mvp_simulator.py` now runs the full simulator MVP ladder:
  local RTL, generated AP manifest gate, QEMU firmware smoke, Renode firmware
  smoke, QEMU OS boot, CPU/AP Linux evidence, Android simulator capture, and
  Android simulator report validation.
- `scripts/run_qemu.sh --check` passes the qemu-virt firmware banner smoke.
- `REQUIRE_RENODE=1 scripts/run_renode.sh --check` passes a bounded Renode
  firmware banner smoke with Renode 1.16.1.
- `scripts/run_qemu.sh --check-os` blocks before launch because no Linux kernel
  `Image` or initrd/rootfs image is available locally.
- `python3 scripts/locate_chipyard_linux_payload.py --require` is the payload
  locator for the generated AP `run-binary` path. It must find a RISC-V ELF
  payload with an OpenSBI marker before `make chipyard-generated-ap-boot` can
  attempt the generated AP simulator.
- `make chipyard-generated-ap-boot` is the only repo-local wrapper that may
  produce `build/chipyard/eliza_rocket/verilator-linux-smoke.log` for a
  generated ElizaRocketConfig Linux smoke. The log is still only proof after
  `scripts/check_chipyard_verilator_linux_smoke.py` finds real OpenSBI and Linux
  markers in that generated-AP transcript.

The Renode and QEMU passes are useful simulator plumbing evidence. QEMU `virt`
is a software-reference boot path, and the current Renode smoke is a Renode
reference-model path; neither closes AP Linux boot, OpenSBI handoff, Android
boot, FPGA, board, or silicon evidence. The MVP simulator report now keeps
reference evidence in `best_reference_evidence`; `best_executable_evidence`
cannot name QEMU, Renode, or Android reference-only results. The report remains
blocked until the generated AP path and real boot payload/evidence paths pass.

## Launch blockers

### 1. Chipyard build environment is not initialized

`external/chipyard` is present and the import preflight passes with the current
skip-remote path:

```sh
python3 scripts/check_chipyard_import_preflight.py --require-checkout --skip-remote
```

The Verilator build path still cannot start because the generated Chipyard
environment has not been produced:

```text
common.mk:5: *** RISCV is unset. Did you source the Chipyard auto-generated env file
```

Required fix:

- Run or reproduce the Chipyard setup flow that creates `external/chipyard/env.sh`
  and a valid RISC-V toolchain environment.
- Keep the Eliza overlay installed at
  `external/chipyard/generators/chipyard/src/main/scala/eliza/ElizaRocketConfig.scala`.
- Avoid full recursive setup paths that require inaccessible optional private
  vendor submodules unless those paths are actually needed for Verilator Linux
  bring-up.

### 2. Generated AP source exists, but executable AP boot evidence is absent

The selected AP path now has generated source artifacts, including:

- `build/chipyard/eliza_rocket/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.memmap.json`
- `build/chipyard/eliza_rocket/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.dts`
- `build/chipyard/eliza_rocket/eliza_rocket_ap.v`

The generated memmap/DTS expose `memory@80000000` at `0x80000000`, size
`0x10000000` / 256 MiB, as the enabled RAM window for OpenSBI/Linux payloads.
The generated DTS also contains `memory@8000000` at `0x08000000`, size
`0x10000` / 64 KiB, but that node is disabled and must not be used for payload
placement. The generated Verilog/FIRRTL includes a `SimDRAM` configured for
`0x80000000`/256 MiB, which is source-level simulator memory evidence only.

The launch blocker remains: no generated Verilator simulator executable or
boot transcript exists for this AP path.

Required fix:

- Build the generated `ElizaRocketConfig` Verilator simulator.
- Locate or build a single-ELF Chipyard Linux payload:

```sh
python3 scripts/locate_chipyard_linux_payload.py --require
cd external/chipyard/software/firemarshal && ./marshal -v -d build example-workloads/linux-poweroff.json
```

- Run the generated AP smoke only through the bounded wrapper:

```sh
export CHIPYARD_LINUX_BINARY=/abs/path/to/linux-poweroff-bin-nodisk
make chipyard-generated-ap-boot
python3 scripts/check_chipyard_verilator_linux_smoke.py
```

- Archive all generated paths, tool versions, commands, recursive submodule
  state, and SHA-256 values in the generated manifest.
- Bind OpenSBI, Linux Image, initrd, and DTB placement to the `0x80000000`
  payload memory window and keep all payloads inside the 256 MiB generated RAM
  range unless the AP configuration changes.
- Capture OpenSBI/Linux serial transcripts from the generated AP simulator.
- Keep the platform contract in non-claiming mode until evidence passes.

### 3. Boot payloads are absent

The OS launch preflight blocks on missing payloads:

- Linux kernel `Image`
- initrd/rootfs image
- boot DTB
- OpenSBI/U-Boot handoff artifacts

Required fix:

- Build or import a RISC-V Linux kernel payload for the selected simulator.
- Build or import a minimal rootfs/initrd with a deterministic console smoke.
- Add OpenSBI and U-Boot only when the selected boot flow requires them, then
  capture the full boot chain transcript.

### 4. Checked-in DTS is not a boot DTB

The checked-in scaffold compiles with `dtc`, but it is not a standalone AP boot
device tree:

```sh
python3 scripts/capture_cpu_ap_evidence.py dts-audit --run-dtc --path sw/linux/dts/eliza-e1.dts
```

Current blockers:

- missing CPU node
- missing memory node
- missing timer node
- missing interrupt controller
- missing enabled UART console

Required fix:

- Use the generated Chipyard DTB/DTS as the boot source of truth.
- Keep `sw/linux/dts/eliza-e1.dts` as a peripheral scaffold only unless it
  is expanded into a complete boot DTB.

### 5. CPU/AP evidence is missing

The evidence gate must remain blocked until these real transcripts exist:

- `build/evidence/cpu_ap/eliza_e1_opensbi_boot.log`
- `build/evidence/cpu_ap/eliza_e1_linux_boot.log`
- `build/evidence/cpu_ap/eliza_e1_trap_timer_irq.log`
- `build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log`
- `build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log`

Required fix:

- Capture logs from the generated AP simulator or real hardware path.
- Bind each transcript to the generated manifest path and SHA-256.
- Do not accept placeholders, scaffold-only logs, or missing manifest hashes.

### 6. External BSP evidence is missing

The software BSP evidence gate correctly blocks without external logs for:

- Buildroot/Linux
- OpenSBI
- U-Boot
- AOSP/RISC-V userspace

Required fix:

- Build or import each software component used in the selected boot path.
- Archive command logs and boot/runtime transcripts under the evidence paths
  expected by the existing gates.

## Workstreams issued

- Chipyard import and AP overlay: repair environment setup, generated manifest,
  and Rocket config integration.
- Firmware/Linux boot evidence: audit DTS, boot payload requirements, and BSP
  transcript capture.
- Simulator bring-up: keep QEMU/Renode smoke paths executable and add fail-closed
  OS boot checks.
- CPU/AP completion gates: prevent Linux/AP claims without generated artifacts
  and manifest-bound evidence.
- RTL verification: strengthen CLINT, interrupt, and address-map coverage before
  Linux bring-up.

## Current next command sequence

```sh
python3 scripts/check_chipyard_import_preflight.py --require-checkout --skip-remote
cd external/chipyard && ./build-setup.sh --help
cd external/chipyard/sims/verilator && make CONFIG=ElizaRocketConfig -n
scripts/run_qemu.sh --check
scripts/run_qemu.sh --check-os
REQUIRE_RENODE=1 scripts/run_renode.sh --check
python3 scripts/capture_cpu_ap_evidence.py dts-audit --run-dtc --path sw/linux/dts/eliza-e1.dts
make chipyard-generated-check cpu-ap-evidence-check software-bsp-evidence-check
```
