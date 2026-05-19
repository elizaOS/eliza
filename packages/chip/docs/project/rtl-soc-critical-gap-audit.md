# RTL/SoC critical gap audit

Date: 2026-05-17

Scope: `rtl/**`, `verify/**`, `scripts/run_formal.sh`, `scripts/run_yosys.sh`, `Makefile`, and `docs/three-week-prototype-workstreams.md`.

This audit separates local executable prototype coverage from product or Linux-capable SoC readiness. The current design is useful as a debug-MMIO demonstrator and contract testbed. It is not a bootable phone SoC, and several green checks are scaffold or shallow structural checks.

## Machine-readable gate

The authoritative open-gap manifest is `verify/rtl_gap_work_order.yaml`. `make stub-audit` checks that every critical area keeps explicit open gaps with:

- category,
- severity,
- affected paths,
- current evidence,
- blocking gate,
- closure evidence,
- work order.

Open gap categories are `rtl_stub`, `incomplete_subsystem`, `test_gap`, `proof_gap`, and `misleading_pass_gate`.

## RTL stubs and placeholders

| Gap | Evidence | Blocking interpretation |
| --- | --- | --- |
| CPU subsystem is a tiny executable contract model | `rtl/cpu/e1_cpu_subsystem_stub.sv` supports a small unprivileged instruction subset and still carries the `stub` module name. | Lint, synthesis, and cocotb CPU passes do not prove a production RV64 core, privileged mode, MMU/cache, or OS boot path. |
| Boot ROM is an identity/contract ROM | `rtl/bootrom/e1_bootrom.sv` returns magic/version words and a boot-vector placeholder. | Platform-contract checks do not prove executable reset firmware or OpenSBI handoff. |
| NPU is a bounded MMIO datapath | `rtl/npu/e1_npu.sv` exposes scalar operations and small scratch GEMM behavior. | NPU tests do not prove accelerator IP, descriptor queues, tensor memory, model execution, or performance. |
| DRAM is SRAM-backed modeling | `rtl/memory/e1_axi_lite_dram.sv` and `rtl/top/e1_soc_top.sv` use small AXI-Lite/internal memory apertures. | Synthesis and simulation do not prove a DRAM controller, PHY, refresh/timing, ECC, capacity, or Linux memory behavior. |

## Incomplete subsystems

### CPU and boot

The pad-level top has no production CPU integration, CLINT, PLIC-compatible interrupt target, UART console, cache/MMU, SBI handoff, or real reset ROM. `verify/cocotb/test_tiny_cpu_execution.py` is valuable for contract behavior, but it is not a processor compliance or boot test.

Required closure evidence:

- production RV64 wrapper or selected core integration,
- privileged boot path and reset-state assertions,
- timer, interrupt, memory, and console contract,
- generated DTS consistency,
- executable boot transcript from RTL-equivalent simulation or a clearly labeled reference emulator model.

### Interconnect and memory

`e1_soc_top` routes debug MMIO to fixed windows and a small internal DRAM array. `e1_linux_soc_contract` exercises a CPU-side AXI-Lite contract path to DRAM, DMA MMIO, and interrupt controller, but it is not a complete SoC fabric. It lacks complete target inventory, production arbitration policy, coherency policy, ordering guarantees, and generated address-map binding across RTL and software.

Required closure evidence:

- generated address map from `sw/platform/e1_platform_contract.json`,
- decode-error and backpressure tests for every target,
- protocol properties for valid-ready stability and response liveness,
- arbitration coverage across CPU, DMA, display, and any future NPU memory clients.

### DMA

`rtl/dma/e1_dma.sv` is a word-copy AXI-Lite master with status and error counters. It has useful error behavior for unaligned programming and memory response errors, but it is not proven against a production memory hierarchy, long bursts, coherency, cache interaction, or software performance expectations.

Required closure evidence:

- long transfer coverage,
- partial-beat and byte-lane coverage,
- response matching and restart/clear sequencing,
- coherency policy tests,
- production memory target or verified external memory model.

### NPU

The current NPU has MMIO registers, selected op behavior, and bounded GEMM smoke coverage. It lacks descriptor fetch, queueing, scratchpad/tensor layout, DMA or shared-memory client behavior, backpressure, interrupts beyond simple completion/error status, and coverage accounting for unsupported operations.

Required closure evidence:

- selected accelerator microarchitecture or wrapped IP,
- descriptor ABI and memory interface,
- driver-visible contract,
- opcode/shape/error/IRQ coverage summary,
- performance counters and fallback accounting.

### Display

`rtl/display/e1_display.sv` now has timing and a top-level SRAM-backed framebuffer read path. It still lacks a production framebuffer client, outstanding read handling, QoS/bandwidth proof, panel PHY/DSI bridge, panel init, color/gamma path, and hardware-in-loop validation.

Required closure evidence:

- scanout client against production memory,
- underflow policy and coverage,
- mode programming and pixel-format tests,
- timing assertions for hsync/vsync/active region,
- panel or cycle-accurate trace validation.

## Verification gaps

| Area | Existing evidence | Gap |
| --- | --- | --- |
| CPU | `make cocotb-cpu` contract test | No compliance suite, privilege tests, interrupt entry/return, exceptions, cache/MMU, or boot transcript. |
| Interconnect | `make cocotb-contract` directed tests | No reusable AXI-Lite property set, broad stall permutation matrix, or generated-address-map equivalence proof. |
| DMA | `verify/formal/e1_dma_formal.sv`, cocotb contract tests | Formal depth is shallow and does not prove liveness, full transfer completion, response matching over long transfers, or all backpressure interleavings. |
| NPU | cocotb and Verilator directed tests | No machine-readable opcode/shape/error/fallback coverage report. |
| Display | cocotb directed tests | No dedicated formal timing/read-handshake properties and no real panel validation. |
| Top | `verify/formal/e1_soc_top_formal.sv` | Shallow structural facts only; does not cover AXI-Lite protocol correctness, reset-domain safety, or complete device behavior. |

## Proof gaps

`scripts/run_formal.sh` can run a Yosys fallback when SymbiYosys is missing. That fallback is useful for fast structural sanity, but it is not equivalent to the SBY proof set. Release/signoff CI must use `REQUIRE_SBY=1`; deeper top-level proof should use `REQUIRE_DEEP_FORMAL=1` after stronger properties exist.

Specific proof gaps:

- no dedicated formal harness for `e1_axi_lite_interconnect`,
- no dedicated formal harness for `e1_axi_lite_dram`,
- no dedicated formal harness for `e1_interrupt_controller`,
- no dedicated display proof,
- shallow BMC depths for NPU, DMA, and top,
- no reset-domain or debug-bridge-to-SoC end-to-end liveness proof.

## Misleading pass gates

| Gate | Current behavior | Required labeling |
| --- | --- | --- |
| `make synth` | Synthesizes the prototype source list, including the tiny CPU stub and small memories. | Prototype synthesis only; not production CPU/memory/IP readiness. |
| `make formal` | Runs SBY where available, else Yosys fallback unless `REQUIRE_SBY=1`. | Report fallback as structural/SAT fallback, not proof signoff. |
| `make qemu-check` | Can validate semantic/build scaffolding or report blocked without real QEMU/toolchain. | Not e1-chip boot validation until a contract-compatible model and serial transcript exist. |
| `make renode-check` | Checks a qemu-virt reference scaffold, not the e1 hardware ABI. | Reference scaffold only. |
| `make cocotb` | Directed block/top simulation. | Smoke and contract coverage, not exhaustive subsystem verification. |
| `make stub-audit` | Ensures gaps stay named and open. | Inventory/gate hygiene, not closure of the gaps themselves. |

## Immediate next checks to add

- Coverage summary generation for NPU opcodes, GEMM shapes, invalid configs, status bits, and fallback cases.
- Coverage summary generation for DMA transfer lengths, byte strobes, response errors, restart/clear sequencing, and backpressure.
- AXI-Lite property bindings for interconnect, DRAM, DMA master, interrupt controller, and debug bridge.
- Dedicated display timing and framebuffer-read properties.
- Separate status targets for scaffold checks versus real boot and signoff checks.
