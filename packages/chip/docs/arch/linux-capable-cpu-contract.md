# Linux-capable CPU/AP contract

This document is a requirements gate, not implementation evidence. The current
repo-local executable CPU path is the tiny contract model in
`rtl/cpu/e1_tiny_cpu_contract.sv`; the legacy
`rtl/cpu/e1_cpu_subsystem_stub.sv` name is a compatibility alias only. The
contract model is useful for fetch/execute and bus bring-up, but it is not a Linux-capable hart.

It also separates two targets that must not be conflated:

- `ElizaRocketConfig` is the first generated RV64GC Linux bring-up path.
- A 2028 phone-class application processor is blocked until separate AP
  topology, ISA, cache/MMU, benchmark, power/thermal, Android, and silicon
  evidence exists.

## Current Evidence Boundary

| Area | Evidence allowed today |
| --- | --- |
| CPU execution | Tiny RV instruction subset fetches from DRAM through AXI-Lite and halts fail-closed on unsupported instructions or bus errors. |
| Boot | Focused cocotb wrapper preloads DRAM and releases reset at `0x8000_0000`. |
| Interrupts | Timer, software, and external IRQ levels are reflected through `irq_pending`; no trap entry occurs. |
| Memory | AXI-Lite DRAM aperture is sufficient for tiny programs and contract tests only. |
| Linux/AP claims | Blocked. QEMU and Renode remain software-reference targets, not e1-chip hardware proof. |

## Selected AP Path

`generators/chipyard/eliza-rocket-manifest.json` pins the selected generated
AP path:

- Chipyard `main-2026-05-20` at commit
  `48f904aefbb3903dce6efa7901982642853ae6a7`
  (previous pin: `1.13.0` / `69eba860a352343e4ac6b6df0f3638a79a86ec78`).
- Single Rocket RV64GC hart for the first AP integration.
- Project config name `ElizaRocketConfig`.
- Production wrapper name `eliza_rocket_ap`.

The local tiny CPU must not be expanded into a Linux AP. It remains a contract
test scaffold until generated Rocket/Chipyard artifacts and evidence replace or
wrap the boundary.

The selected single Rocket path is not a phone-class AP target. It can close a
Linux boot smoke gate, firmware handoff gate, and driver bring-up gate. It
cannot close any 2028 phone-class claim without a new selected CPU subsystem
plan and the evidence below.

## 2028 Phone-Class AP Claim Requirements

Before documentation, manifests, or release reports may describe the project as
a 2028 phone-class application processor, the CPU/AP workstream must provide:

| Area | Required evidence |
| --- | --- |
| CPU topology | Application-hart count, microarchitecture choice, frequency/voltage targets, DVFS states, management/security core split, and rationale against contemporary phone AP workloads. |
| ISA compliance | RISC-V application profile or explicit equivalent, extension matrix, `misa`/`riscv_hwprobe` evidence, ISA compliance logs, atomics, compressed instructions, counters, and userspace ABI proof. |
| Cache and coherency | cache hierarchy evidence covering I-cache, D-cache, shared-cache or LLC policy, line size, maintenance operations, DMA/NPU coherency contract, stress tests, and MPKI/counter evidence. |
| MMU | Supported virtual-memory modes such as Sv39 or stronger, TLB behavior, page-table walk behavior, shootdown path, fault precision, and Linux `CONFIG_MMU` boot evidence. |
| Boot | Reset ROM, OpenSBI, U-Boot or documented bootloader equivalent, generated DTS hash, Linux initramfs, Android userspace plan, and serial transcripts from the selected AP target. |
| Benchmarks | CoreMark/MHz, STREAM, `lmbench` bandwidth/latency, `fio`, selected SPEC-like kernels, run count, clocks, memory config, thermal state, power method, process_14a_corner_benchmark_derate_evidence, and raw artifacts. |
| Android and product | CTS/VTS/userspace evidence, scheduler/thermal integration, security/debug lifecycle, and phone-board evidence before compatibility or product claims. |

Until all of those gates pass, the allowed claim is only "generated Rocket
RV64GC Linux bring-up path selected, evidence blocked."

## Minimum CSR, Trap, And Timer Requirements

A Linux-capable AP path must implement or integrate a core/platform with at
least:

- RV64 privileged M-mode entry with `mstatus`, `misa`, `mie`, `mip`, `mtvec`,
  `mepc`, `mcause`, `mtval`, `mscratch`, `medeleg`, `mideleg`, and `mret`.
- S-mode support required by OpenSBI/Linux, including `satp`, `sstatus`,
  `sie`, `sip`, `stvec`, `sepc`, `scause`, `stval`, and `sret`.
- CLINT-compatible machine timer/software interrupt semantics or a documented
  equivalent consumed by OpenSBI: `mtime`, `mtimecmp`, and `msip`.
- External interrupt target compatible with the selected Linux interrupt
  controller binding, with claim/complete semantics tested from firmware.
- Trap entry that records the precise faulting PC/cause for illegal
  instruction, load/store/fetch access fault, timer interrupt, software
  interrupt, and external interrupt.
- Reset handoff from ROM or firmware entry, with a checked serial transcript
  proving OpenSBI reaches the next boot stage on the e1-chip memory map.

## Required Evidence Artifacts

Placeholder files do not close this gate; each log must come from the selected
generated or wrapped CPU/AP target and must include the listed markers.

| Artifact | Required markers |
| --- | --- |
| `build/evidence/cpu_ap/eliza_e1_opensbi_boot.log` | Reset PC, hart ID, `misa`, `mstatus`, `mtvec`, timer source, interrupt controller, UART console, DRAM base/size, and OpenSBI next-stage handoff. |
| `build/evidence/cpu_ap/eliza_e1_linux_boot.log` | Linux early console, generated DTS hash, memory node, CPU node, timer node, interrupt-controller node, UART node, initramfs start, and e1 MMIO smoke result. |
| `build/evidence/cpu_ap/eliza_e1_trap_timer_irq.log` | Illegal-instruction trap with `mcause`, `mepc`, and `mtval`; load/store/fetch access-fault traps; `mtime`/`mtimecmp` timer interrupt; software interrupt through `msip`; external interrupt claim/complete; return path through `mret` or `sret` as appropriate. |
| `build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log` | ISA profile, `misa`, `riscv_hwprobe`, required base extension visibility, Sv39 or stronger MMU evidence, I-cache/D-cache/L2 cache parameters, cache-line size, TLB behavior, and page-table evidence. |
| `build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log` | Benchmark report SHA-256, claim level, CoreMark/MHz, STREAM Triad, `lat_mem_rd`, `fio`, CPU frequency, run count, thermal state, power method, process effects contract, worst process corner, frequency derate, and pdk signoff claim=none. |

## Exact Linux-Capable Gate States

`docs/evidence/cpu-ap-evidence-manifest.json` is the source of truth for the
current gate states. Every gate below is intentionally `blocked` until its
evidence path exists, is bound to
`build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json`, and the
archived transcript ends with `eliza-evidence: status=PASS`.

| Gate | Evidence required before PASS |
| --- | --- |
| `rv64gc_isa` | RV64GC ISA profile, `misa`, `Zicsr`, `Zifencei`, and `riscv_hwprobe` markers. |
| `s_mode_privilege` | M-mode and S-mode CSR/delegation markers including `mstatus`, `medeleg`, `mideleg`, `satp`, and `sret`. |
| `mmu_sv39_or_stronger` | Sv39 or stronger MMU evidence, `satp`, TLB behavior, page-table evidence, and Linux `CONFIG_MMU`. |
| `clint_timer_software_irq` | CLINT/ACLINT `mtime`, `mtimecmp`, `msip`, timer interrupt, and software interrupt evidence. |
| `plic_external_irq` | PLIC-compatible interrupt-controller node plus external interrupt claim/complete evidence. |
| `uart_console` | UART console path visible to firmware and Linux early console. |
| `dtb_linux_boot_contract` | Generated DTS with CPU, memory, timer, interrupt-controller, UART, and chosen stdout nodes. |
| `opensbi_handoff` | OpenSBI transcript reaching the next-stage handoff on the selected memory map. |
| `linux_initramfs_smoke` | Linux early console, initramfs start, and e1 MMIO smoke result from the generated AP target. |

`docs/evidence/linux-hardware-contract-gate.yaml` adds a local fail-closed
scaffold gate for the RTL CPU, memory, interrupt, timer, and UART paths. Its
checker, `python3 scripts/check_linux_hardware_contract_gate.py`, must pass only
when the local RTL remains clearly documented as a non-Linux scaffold and every
minimum Linux boot axis is still blocked pending executable evidence. The same
checker also validates that `scripts/run_qemu.sh --check-os`,
`docs/evidence/linux/qemu-virt-linux-payload-plan.json`, and any
`build/reports/qemu_os_boot_attempt.json` artifact remain marked as qemu-virt
reference-only evidence, not chip RTL boot evidence.

QEMU `virt` OS boot attempts are useful software-reference evidence only. The
bounded attempt log at `build/reports/qemu_os_boot_attempt.log` may be
`BLOCKED`, `FAIL`, or `PASS`, but it cannot satisfy any generated
Chipyard/Rocket AP gate.

Generated DTS, memmap, regmap, or Verilog files under
`build/chipyard/eliza_rocket` are also not sufficient by themselves. Run
`python3 scripts/check_chipyard_generated_linux_contract.py` to audit their
Linux launch shape; a structural DTS pass only means the generated AP exposes
the expected CPU, memory, CLINT, PLIC, UART, ROM, and boot-address nodes.
OpenSBI/Linux claims remain blocked until the import manifest and executable
transcripts satisfy the evidence manifest.

The current tiny CPU cannot produce these markers because it has no CSR file,
trap vector, privilege mode, timer facility, OpenSBI handoff, Linux early
console, or firmware-to-kernel handoff path.

## Actionable Next Commands

Run the local non-claiming scaffold checks:

```sh
make chipyard-generator-check cpu-ap-scaffold-check cpu-ap-completion-gate
```

Prepare the external generated AP path:

```sh
make chipyard-external-generation-plan
python3 scripts/check_chipyard_import_preflight.py --require-checkout
python3 scripts/check_chipyard_verilator_preflight.py
scripts/run_chipyard_eliza_verilator.sh
python3 scripts/generate_chipyard_eliza.py
make chipyard-generated-check
make cpu-ap-dts-audit chipyard-generated-linux-contract-check
```

Archive real transcripts only after the generated AP target has produced them:

```sh
python3 scripts/capture_cpu_ap_evidence.py plan all --format shell
scripts/capture_chipyard_linux_evidence.sh preflight
python3 scripts/capture_cpu_ap_evidence.py intake opensbi-boot --source /path/to/opensbi.log --command '/exact/boot command'
python3 scripts/capture_cpu_ap_evidence.py intake linux-boot --source /path/to/linux.log --command '/exact/boot command'
python3 scripts/capture_cpu_ap_evidence.py intake trap-timer-irq --source /path/to/trap.log --command '/exact/test command'
python3 scripts/capture_cpu_ap_evidence.py intake isa-cache-mmu --source /path/to/isa-cache-mmu.log --command '/exact/isa-cache-mmu command'
python3 scripts/capture_cpu_ap_evidence.py intake ap-benchmarks --source /path/to/ap-benchmarks.log --command '/exact/benchmark command'
python3 scripts/capture_cpu_ap_evidence.py hashes
```
# Linux-Capable CPU Contract

`rtl/cpu/e1_tiny_cpu_contract.sv` is a tiny executable contract model. The
legacy `rtl/cpu/e1_cpu_subsystem_stub.sv` module is a compatibility alias only.
The contract model is useful for fetch/execute, bus, and negative trap tests,
but it is not a Linux-capable application processor.

Required closure before any CPU/AP claim:

- A production-named CPU/AP top wrapper, with any legacy `stub` wrapper kept
  below the release claim boundary.
- RV64GC or explicitly justified RV64 Linux-capable ISA support.
- MMU, privilege, CSR, timer, interrupt, cache, and memory-ordering evidence.
- OpenSBI boot log, Linux early-console boot log, and trap/timer IRQ transcript
  under `build/evidence/cpu_ap/`.
- Linux early console must show firmware-to-kernel handoff details, including
  `mcause`, `mepc`, `mtimecmp`, and external interrupt claim/complete behavior.
- Fail-closed gates that separate scaffold presence from executable hardware
  evidence: `make cpu-ap-scaffold-check` may pass, while
  `make cpu-ap-evidence-check` must block until real evidence exists.
