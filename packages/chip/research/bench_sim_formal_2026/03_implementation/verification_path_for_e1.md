# Verification path for Eliza E1

Generated 2026-05-19. Each recommendation is anchored to a specific file
under `verify/`, `benchmarks/`, `docs/benchmarks/`, or
`docs/three-week-prototype-workstreams.md` so that the change set is
auditable and stays inside the current claim ladder.

## Critical assessment (current state)

Strengths:

- The claim ladder in `docs/benchmarks/claim-ladder.md` is honest and the
  schema validator in `docs/benchmarks/report-schema.yaml` enforces it.
- `benchmarks/run_benchmarks.py` correctly refuses to mark host smoke
  shims as evidence; strict mode is wired in.
- `docs/toolchain/benchmark-simulator-critical-gap-audit.md` already
  catalogs the QEMU/Renode fake-versus-real risk; this packet does not
  need to re-litigate it.
- `verify/cocotb/` has block-level testbenches (`test_e1_npu`, `test_e1_dma`,
  `test_e1_display`, `test_e1_soc`, `test_e1_chip`) and a working
  Verilator+cocotb path.
- `verify/formal/*.sby` produces real formal evidence under
  `REQUIRE_DEEP_FORMAL=1`.

Gaps (cross-checked against Workstream A and E in
`docs/three-week-prototype-workstreams.md`):

1. SMT solver: only `smtbmc z3`. Boolector is end-of-maintenance; Bitwuzla
   is the explicit migration target named in the workstream document but
   not yet wired.
2. No `mode prove` (k-induction) on any block; BMC depth is small.
3. No AXI-Lite protocol property file applied to `rtl/interconnect/` and
   `rtl/memory/`.
4. No reset / CDC properties wired in even though `verify/properties/`
   exists.
5. No functional-coverage merge step (cocotb-coverage is not in
   `requirements.txt`).
6. No L2_ARCH_SIM CPU+memory model. `benchmarks/sim/run_npu_scale_sim.py`
   covers only the NPU side.
7. No Accelergy/Timeloop energy column for NPU work; SCALE-Sim alone does
   not produce the joules-per-inference required by
   `docs/benchmarks/benchmark-matrix.md`.
8. NPU performance counters are `basic_performance_counters` per
   `npu-2028-target.yaml#current_repo_classification.implemented_now`.
   Insufficient for per-workload power-per-counter attribution at L3+.
9. No Spike / Sail RISC-V lockstep co-simulation for the CPU lane; this
   is a prerequisite for differential RTL fuzzing.
10. No MLPerf Power-style integrated-energy reporting profile in the
    benchmark schema; only `power_trace` as a string-tagged file.

## High-confidence recommendations (implement first)

These are tightly scoped, do not change product claims, and unblock named
Workstream gaps.

### H1. Add Bitwuzla as a second formal engine across all .sby

Files touched (proposed; no edits made in this packet):
`verify/formal/e1_dma.sby`, `verify/formal/e1_npu.sby`,
`verify/formal/e1_soc_top.sby`, `verify/formal/e1_dbg_mmio_bridge.sby`.

Add an `[engines]` line `smtbmc bitwuzla` alongside the existing
`smtbmc z3` so SBY runs both and CI flags disagreement. Closes the
Workstream E Bitwuzla evaluation gap. Bitwuzla is a drop-in replacement
for Boolector (which is end-of-maintenance) per the upstream README at
[bitwuzla] in `01_sources/source_inventory.yaml`.

### H2. Add cocotb-coverage and a JSON merge step

Files touched: `requirements.txt`, `verify/cocotb/Makefile`,
`verify/cocotb/test_e1_*.py`, new `scripts/check_cocotb_coverage.py`.

Add cover-points per block (opcodes, MMIO regions, IRQ vectors, AXI-Lite
response codes). Emit per-test JSON under
`build/reports/coverage/<block>.json`. Add a merge step that produces a
single summary file the existing `scripts/check_*.py` gates can consume.
Closes the "no coverage report" gap named in Workstream A.

### H3. Add reset and CDC properties via verify/properties/

Files touched: `verify/properties/*.sv` (existing directory), all .sby
scripts.

Reset-after-power-on, X-propagation on reset release, and CDC handshake
properties are short, high-catch-rate, and currently absent from the
formal flow. Add them and reference them from each `.sby` `[script]`
block.

### H4. Add AXI-Lite open protocol properties

Files touched: `verify/properties/axi_lite_protocol.sv` (new),
`verify/formal/e1_axi_lite_interconnect.sby` (new),
`verify/formal/e1_axi_lite_dram.sby` (new).

Cover AR/R, AW/W/B handshake invariants, response-code legality,
ordering, and outstanding-transaction bounds. Workstream A names this
explicitly as a blocker.

### H5. Wire Accelergy + Timeloop into the NPU sim flow

Files touched: `benchmarks/sim/run_npu_scale_sim.py`,
`compiler/runtime/e1_npu_scale_model.py`, new `benchmarks/sim/run_npu_timeloop.py`,
new entries in `benchmarks/configs/benchmark_plan.json`.

Output the joules-per-inference column the matrix demands. The first
deliverable is a modeled-energy column at L2_ARCH_SIM with explicit
`provenance: simulator`.

### H6. Expand NPU performance counters in RTL

Files touched: `rtl/npu/e1_npu.sv`, `verify/cocotb/test_e1_npu.py`,
`sw/platform/e1_platform_contract.json`.

Add cycle, stall (memory wait), SRAM bandwidth, DMA bandwidth, and a
thermal-throttle counter MMIO surface. Required input for both modeled
(L1/L2) and measured (L3+) power-per-counter attribution. Aligns the
`implemented_now` list in `npu-2028-target.yaml` with the
`performance_counter_virtualization` reliability target.

### H7. Adopt Hypothesis in the benchmark + check-script test suites

Files touched: `benchmarks/parsers/tests/`, `scripts/test_*.py`,
`requirements.txt`.

Replace example-based unit tests in the parsers and check scripts with
property-based tests. Schema validation, parser robustness, and
status-code policies are the natural shape for Hypothesis strategies.

## Medium-confidence recommendations

### M1. Stand up a gem5 model alongside Verilator

Add a gem5 configuration that mirrors the selected Chipyard Rocket
choice (Workstream B). Use `MinorCPU` for an in-order Rocket-class
model. Wire McPAT for modeled energy. Add a new benchmark entry
`simulator_arch_metrics_gem5` to `benchmarks/configs/benchmark_plan.json`
that emits target-cycle counts, MPKI, BW utilization.

Why medium: depends on the CPU/AP lane producing generated artifacts
first (Workstream B blocker).

### M2. Pilot Spike / Sail RISC-V lockstep against the CPU lane

Use Spike as the architectural golden model, and Sail RISC-V for the
formal-quality executable spec. Stand up a cocotb test that runs the
RTL CPU under Verilator with Spike running in lockstep and compares
architectural state at every commit. Prereq for M3.

### M3. Pilot DifuzzRTL on the same CPU lane

Coverage-guided differential RTL fuzzer. KAIST 2021, periodically
maintained. Requires the M2 lockstep substrate.

### M4. Add EBMC as a second formal frontend on AXI-Lite properties

Yosys' SVA support is partial. EBMC handles richer SVA. Useful as a
cross-checker once the H4 property file exists.

### M5. Move from BMC to k-induction on small leaves

Once Bitwuzla (H1) is stable in CI, switch `e1_dbg_mmio_bridge.sby`
and a stripped-down `e1_dma.sby` leaf to `mode prove`. Increases the
strength of the proof obligation from bounded-depth exploration to
unbounded.

### M6. Add MLPerf Power-style integrated-energy report row

Files touched: `docs/benchmarks/report-schema.yaml`,
`benchmarks/run_benchmarks.py`.

Adopt the MLPerf Power approach: integrated energy over the measured
QPS run, divided by completed inferences. Today the schema only tags a
power_trace file. Adding an `energy_joules_per_inference` field with
required calibration metadata (instrument, sampling rate, integration
window) makes the field semantically real.

## Low-confidence recommendations (defer)

### L1. NeuroSim for CIM modeling

Only relevant if a CIM tile becomes an E1 roadmap item.

### L2. ASTRA-sim for multi-die

Only relevant if a multi-die phone AP variant becomes a roadmap item.

### L3. PowerNet for ML-driven IR-drop

Belongs to the PD lane, not pre-silicon.

### L4. Procyon AI / PassMark AI

Windows-only or desktop-positioning; not in scope for the Android-first
SoC.

## Things explicitly out of scope for this packet

- No edits to `verify/`, `benchmarks/`, or `docs/benchmarks/` are
  proposed inside this packet; the recommendations above name target
  files but the work belongs to a follow-up change set per the chip
  package working rules in `packages/chip/CLAUDE.md`.
- No new claim levels. The claim ladder is correct as written.
- No vendor-tool acquisitions. The open-tool lane (Verilator + cocotb +
  SBY + Yosys + Bitwuzla + Z3) is sufficient for L0_RTL_UNIT through
  L3_FPGA. JasperGold / VC Formal / VCS / Xcelium are positioning only.

## Mapping back to the npu-2028-target.yaml evidence list

| Required evidence | How this plan produces it |
|---|---|
| `MLPerf_Mobile_or_equivalent_closed_loop` | L4_SILICON_ANDROID lane only; pre-silicon work is operator-level (DeepBench + per-workload TFLite functional checks). |
| `tflite_benchmark_model_with_accelerator_name` | Already in the harness, gated by `benchmarks/capabilities/e1_npu_nnapi.proof.json`. |
| `unsupported_operator_report` | TFLite delegate trace; existing harness column. |
| `CPU_fallback_report` | Same source as above. |
| `power_trace` | M6 schema field + H5 Accelergy column at L2; Joulescope/Monsoon + Perfetto at L3+. |
| `thermal_trace` | Perfetto + `/sys/class/thermal` at L3+; modeled `thermal_throttle_counters` exposed by H6 at L1/L2. |

## Mapping back to claim levels

| Level | Substrates available after this plan |
|---|---|
| L0_RTL_UNIT | cocotb (existing) + cocotb-coverage (H2) + SBY/Bitwuzla (H1) + reset+CDC props (H3). |
| L1_RTL_FULL_SOC | Verilator full SoC + cocotb (existing) + cocotb-coverage merge. |
| L2_ARCH_SIM | SCALE-Sim v2 (existing) + Accelergy/Timeloop (H5) + gem5+McPAT (M1). |
| L3_FPGA | Chipyard + FireSim once Workstream B unblocks. |
| L5_PROTOTYPE_SILICON | Monsoon/Joulescope + Perfetto + thermal harness. Requires real silicon; not in scope of this packet. |
| L6_COMPLETE_PHONE | MLPerf Mobile / MLPerf Power closed loop on a complete phone. Requires L5 first. |
