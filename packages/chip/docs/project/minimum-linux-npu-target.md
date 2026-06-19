# Minimum Linux + NPU Target

This is the minimum executable target for the current integration wave: boot a
basic Linux kernel on the simulated e1-chip/generated AP target and run a
deterministic INT8 ML smoke workload through the e1 NPU path.

This is not Android readiness, phone-class performance, tapeout readiness, or
sustained power/thermal proof. QEMU/Renode reference boots may unblock software
plumbing, but they do not satisfy this target unless the generated e1-chip/AP
simulator is the target under test.

## Status Terms

| Status | Meaning |
|---|---|
| present | Repo source, scaffold, or checker exists and is linked below. |
| missing | Required source or target-side command does not exist yet. |
| evidence-required | Source may exist, but the target cannot be claimed until generated artifacts, external build logs, boot transcript, or workload transcript are captured and accepted. |

## Acceptance Definition

The repo-local aggregate gate is `make minimum-linux-npu-target-check`. The
narrower basic Linux kernel gate is `make minimum-linux-target-check`; it writes
`build/reports/minimum-linux-kernel-target.json` and verifies the boot payload,
DTS, console, driver/MMIO smoke, required artifacts, and required local blocker
states before the ML workload is claimed.

`build/reports/minimum_linux_npu_target.json` keeps diagnostic attempts separate
from accepted transcripts. Accepted CPU/AP intake may identify the transcript
with the archived `eliza-evidence: target=cpu_ap artifact=eliza_e1_linux_boot`
envelope while the raw FireMarshal body may also contain the generated-AP smoke
marker. `remaining_blockers` lists the accepted transcript path, whether any
simulator log is diagnostic-only, and the exact missing or fallback markers that
still block the integrated Linux+NPU claim.
For the CPU/AP bundle, the aggregate report also names the current
ISA/cache/MMU companion report at
`build/evidence/cpu_ap/cpu_ap_isa_cache_mmu_probe.json`, the legacy fallback
report path if that is the only local report available, the required Linux
userspace marker `riscv_hwprobe: syscall rc=0`, and the AP benchmark dependency
on an accepted `build/evidence/cpu_ap/eliza_e1_linux_boot.log` transcript.
This gate imports the CPU/AP checker as a sidecar, but its minimum required
subset is explicit: accepted OpenSBI boot, Linux boot, ISA/cache/MMU, and AP
benchmark transcripts. Broader CPU/AP blockers, such as trap/timer/IRQ
regeneration, stay visible as diagnostic context unless they affect that subset.
The generated Linux/NPU sub-gate also carries the CPU/AP intake state for the
accepted Linux transcript, so a marker-complete but stale archived transcript
remains blocked until it is refreshed through intake.
The strict gate treats `/dev/mem`, devmem-only, and any nonzero CPU fallback
markers as negative proof even if other PASS strings are present. The accepted
minimum evidence block names the exact fresh transcript paths:
`build/evidence/cpu_ap/eliza_e1_linux_boot.log`,
`build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log`, and
`build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log`. ISA/cache/MMU evidence must
include Linux userspace `riscv_hwprobe: syscall rc=0`, and AP benchmark evidence
must be intaken after the accepted Linux boot transcript.

The target is complete only when one generated-AP Linux transcript proves:

1. The simulator is the e1-chip/generated AP target, not qemu-virt-only.
2. The boot payload is a RISC-V ELF selected by
   `scripts/locate_chipyard_linux_payload.py` with OpenSBI and Linux payload
   markers.
3. Linux reaches a shell, init script, or equivalent command runner.
4. The DTS visible to Linux contains CPU, memory, CLINT/ACLINT, PLIC, UART
   console, DMA, display, and e1 NPU nodes matching
   `sw/platform/e1_platform_contract.json`.
5. The console transcript contains `OpenSBI`, `Linux version`,
   `Kernel command line:`, and a shell/init marker.
6. The kernel exposes `/dev/e1-npu` for the e1 NPU path. `/dev/mem` MMIO
   bring-up probes may remain diagnostic, but they do not satisfy the strict
   generated Linux+NPU transcript gate.
7. A userspace NPU ML smoke runs `GEMM_S8`, prints input hash, output hash or
   matrix values, and stable PASS/FAIL markers.
8. A checker fails closed if the transcript is missing, if the simulator is a
   reference platform, if the ML command used CPU-only fallback, if proof came
   only through `/dev/mem`/devmem, or if AP benchmark or ISA/cache/MMU evidence
   is missing or stale.

## Reference Map

| Area | Repo reference | Current gate or command | What it proves |
|---|---|---|---|
| Chipyard Linux smoke | `scripts/run_chipyard_eliza_linux_smoke.sh` | `make chipyard-generated-ap-boot` | Attempts generated AP OpenSBI/Linux smoke. |
| Chipyard smoke checker | `scripts/check_chipyard_verilator_linux_smoke.py` | `make chipyard-verilator-linux-smoke-check` | Validates generated AP smoke artifacts and boot markers. |
| Linux payload locator | `scripts/locate_chipyard_linux_payload.py` | `make chipyard-linux-payload-check` | Finds a runnable FireMarshal/Chipyard Linux ELF payload. |
| CPU/AP evidence | `scripts/capture_cpu_ap_evidence.py` | `make cpu-ap-evidence-check` | Validates OpenSBI, Linux, trap/timer/IRQ, ISA/cache/MMU, and AP benchmark transcripts. |
| Platform contract | `sw/platform/e1_platform_contract.json` | `make platform-contract-check` | Source of truth for e1 MMIO addresses and generated software headers. |
| Generated Linux contract | `scripts/check_chipyard_generated_linux_contract.py` | `make chipyard-generated-linux-contract-check` | Checks generated DTS/memory-map/regmap exposure for Linux launch. |
| Linux BSP source | `docs/sw/linux/README.md` | `make linux-bsp-check` | Checks repo-local Linux BSP scaffold source. |
| Linux import | `sw/linux/scripts/import-linux-bsp.sh` | `make linux-import-check` | Validates import into an external Linux tree when `LINUX_TREE` is set. |
| Linux evidence capture | `sw/linux/scripts/capture-linux-bsp-evidence.sh` | `make linux-boot-artifacts-check` | Captures external kernel build, DTB, OpenSBI handoff, serial boot, and runtime MMIO smoke evidence. |
| Linux NPU ML evidence capture | `sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux ml-smoke` | `E1_NPU_ML_SMOKE_CMD='ssh root@TARGET /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu --workload gemm_s8_int8_2x2x3 --require-npu' ...` | Captures target-side `/dev/e1-npu` userspace GEMM smoke output, hashes, counters, and zero-fallback PASS markers. |
| Software BSP aggregate | `scripts/check_software_bsp.py` | `make software-bsp-check` | Keeps Linux, Buildroot, AOSP, OpenSBI, and U-Boot scaffold/evidence status fail-closed. |
| Linux DTS | `sw/linux/dts/eliza-e1.dts` | `make linux-bsp-check` | Names CPU, timer, PLIC, UART, NPU, DMA, and display nodes for the scaffold. |
| Linux config fragment | `sw/linux/configs/eliza_e1.fragment` | `make linux-bsp-check` | Names kernel symbols needed by the external Linux target. |
| MMIO smoke source | `sw/linux/tests/e1-mmio-smoke.c` | `make software-bsp-evidence-check` | Probes `/dev/e1-npu` and e1 MMIO base markers at runtime. |
| Minimum Linux kernel gate | `scripts/check_minimum_linux_target.py` | `make minimum-linux-target-check` | Verifies Linux required artifacts, required local blocker states, and aggregate generated-AP Linux status. |
| Minimum Linux+NPU gate | `scripts/check_minimum_linux_npu_target.py` | `make minimum-linux-npu-target-check` | Ties Linux boot blockers, NPU ML smoke evidence, reports, and integrated-claim policy into one aggregate report. |

## Detailed Checklist

| Item | Status | Evidence or blocker | Existing target/script |
|---|---|---|---|
| Select a Linux-capable RV64 AP path for the minimum target. | present | `chipyard_rocket` is named in the CPU/AP work order. | `make cpu-ap-scaffold-check` |
| Keep the tiny CPU model out of Linux claims. | present | The platform contract records the checked-in tiny CPU boundary. | `make platform-contract-check` |
| Provide the Eliza Rocket generator source. | present | The Eliza Rocket Scala config exists. | `make chipyard-generator-check` |
| Pin and bootstrap the external Chipyard checkout. | evidence-required | Release evidence needs recorded upstream SHA, setup command, and generated manifest. | `make chipyard-import-preflight` |
| Generate Verilog, FIRRTL, DTS, and manifest for the selected AP. | evidence-required | Required generated artifacts must be present and hashed. | `make chipyard-generated-check` |
| Confirm generated DTS/memory-map/regmaps expose Linux launch nodes. | evidence-required | Needs generated Chipyard artifacts, not only checked-in scaffolds. | `make chipyard-generated-linux-contract-check` |
| Locate a Chipyard-compatible OpenSBI/Linux ELF payload. | evidence-required | Preferred FireMarshal payload must be present or built on the Linux host. | `make chipyard-linux-payload-check` |
| Run generated AP OpenSBI/Linux smoke on the e1 target. | evidence-required | Requires OpenSBI and Linux version markers in the generated-AP log. | `make chipyard-generated-ap-boot` |
| Reject qemu-virt-only proof for this target. | present | The generated-AP smoke checker accepts only generated artifacts and markers. | `make chipyard-verilator-linux-smoke-check` |
| Provide OpenSBI or equivalent firmware path. | evidence-required | OpenSBI handoff transcript remains external evidence. | `make linux-boot-artifacts-check` |
| Provide a Linux kernel build path for the generated platform. | present | Linux BSP import and capture scripts exist. | `make linux-import-check` |
| Capture external Linux kernel build transcript. | evidence-required | The `.BLOCKED` marker must be replaced by a real external Linux build log. | `sw/linux/scripts/capture-linux-bsp-evidence.sh` |
| Compile and validate the Eliza DTB in an external Linux tree. | evidence-required | The real DTB log must include the e1 NPU compatible. | `sw/linux/scripts/capture-linux-bsp-evidence.sh` |
| Provide deterministic boot command line. | present | The checked-in DTS has serial console bootargs. | `make linux-bsp-check` |
| Device tree names CPU, timer, interrupt controller, UART, NPU, DMA, and display. | present | The checked-in DTS includes scaffold nodes for those blocks. | `make linux-bsp-check` |
| Device tree uses Linux-driver-compatible e1 NPU compatible string. | present | Checked-in DTS and Linux driver compatible strings are aligned. | `make linux-bsp-check` |
| Kernel config enables Eliza NPU and DMA drivers. | present | Linux fragment includes Eliza driver symbols. | `make linux-bsp-check` |
| Linux NPU char device exists. | present | The Linux NPU driver registers misc device `e1-npu`. | `make linux-bsp-check` |
| Runtime MMIO smoke probes `/dev/e1-npu`. | present | The MMIO smoke source opens `/dev/e1-npu`. | `make software-bsp-check` |
| Runtime MMIO smoke proves actual target execution. | evidence-required | Linux runtime transcript remains blocked until captured externally. | `make linux-boot-artifacts-check` |
| Generated platform headers match the contract. | present | Generated software headers are checked against the platform contract. | `make platform-contract-check` |
| Linux userspace ML smoke command exists. | present | `sw/linux/tests/e1-npu-smoke.c` provides deterministic target-side GEMM smoke source. | `make software-bsp-check` |
| Integrated Linux ML smoke rejects CPU-only fallback. | evidence-required | Integrated claim remains false until generated-AP Linux transcript has NPU workload PASS markers. | `make minimum-linux-npu-target-check` |
| Kernel, DTB, OpenSBI, serial boot, and smoke evidence manifest exists. | present | `docs/evidence/linux/eliza-linux-boot-artifacts.json` defines required transcript markers. | `make linux-boot-artifacts-check` |
| CPU/AP boot readiness checker exists. | present | The readiness checker aggregates generated AP and Linux artifact blockers. | `make cpu-ap-boot-readiness-check` |
| End-to-end minimum Linux+NPU target gate exists. | present | The aggregate checker writes one JSON report for Linux and NPU evidence. | `make minimum-linux-npu-target-check` |

## Closure Sequence

1. Import the BSP into an external Linux tree with
   `sw/linux/scripts/import-linux-bsp.sh /path/to/linux`.
2. Capture kernel build and DTB validation with
   `sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux kernel-build`
   and `dtb-check`.
3. On a Linux host with Chipyard/FireMarshal, generate Eliza Rocket
   artifacts, locate or build the Linux payload, and run
   `make chipyard-generated-ap-boot chipyard-verilator-linux-smoke-check`.
4. Capture complete generated-AP serial boot and runtime MMIO/NPU smoke logs.
   The Linux-side NPU smoke is captured with
   `E1_NPU_ML_SMOKE_CMD='<target command>' sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux ml-smoke`.
5. After CPU/AP intake and Linux doc sync, run
   `python3 scripts/check_cpu_ap_evidence.py --require-evidence`,
   `python3 scripts/check_minimum_linux_target.py --strict`, and
   `python3 scripts/check_minimum_linux_npu_target.py --strict`. Until the
   accepted generated AP Linux transcript contains both boot and NPU ML PASS
   markers, the aggregate target must remain BLOCKED instead of inventing proof.
