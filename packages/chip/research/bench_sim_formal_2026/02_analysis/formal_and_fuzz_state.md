# Formal verification, SMT solvers, RTL fuzzing, and PBT

Current state in repo:

- `verify/formal/*.sby` all run `mode bmc` with depth 4-12 and `smtbmc z3`.
- Targets: `e1_dma_formal`, `e1_npu_formal`, `e1_soc_top_formal`,
  `e1_dbg_mmio_bridge_formal`.
- `docs/three-week-prototype-workstreams.md` Workstream E names Boolector
  end-of-maintenance and flags Bitwuzla as the evaluation target.
- `verify/cocotb/` carries randomized testbenches and is the practical
  coverage substrate. There is no UCIS-style coverage merge today.

This document catalogs what is publicly available and recommends
high-confidence migrations and additions.

## Formal flow today

`SymbiYosys` (`sby`) [symbiyosys] drives Yosys' `smt2` backend
[yosys_smtbmc], which produces an SMT2 trace consumed by the named solver.
All scripts pin `[engines] smtbmc z3` and `[options] mode bmc`. The depth
budget is small: 4 for `e1_soc_top.sby`, 8 for `e1_npu.sby`, 12 for
`e1_dma.sby`. Per the heartbeat update in
`docs/three-week-prototype-workstreams.md`, deep formal is only treated as
release evidence under `REQUIRE_DEEP_FORMAL=1`.

This is sound for the current RTL but leaves three concrete gaps:

1. No k-induction (`mode prove`) on any block. BMC alone is bounded-depth
   exploration, not unbounded property proof.
2. No AXI-Lite protocol property set against `rtl/interconnect/` or
   `rtl/memory/`. Workstream A names this explicitly.
3. Reset-domain and CDC properties are absent. `verify/properties/`
   exists but is not loaded in the .sby scripts.

## SMT solver migration

| Solver | Status | Notes |
|---|---|---|
| Z3 [z3] | Production | Robust general-purpose SMT; well supported by yosys-smtbmc. |
| Bitwuzla [bitwuzla] | Production successor to Boolector | Native QF_BV / QF_ABV / QF_FP, faster than Z3 on bit-blasted RTL queries. Drop-in for the `smtbmc` `--solver` argument. |
| Boolector [boolector] | End-of-maintenance | Do not adopt new properties against it. |
| cvc5 [cvc5] | Production | Useful as a cross-check; sometimes resolves cases Z3 stalls on. |

Recommended migration:

1. Add `smtbmc bitwuzla` as a second engine line in each `.sby`. Keep
   `smtbmc z3` so that the project has two independent solvers verifying
   the same proof obligations.
2. Run both engines in CI; treat a disagreement (one proves, the other
   times out) as an unstable property and fix it.
3. After Bitwuzla is stable in CI, evaluate `mode prove` (k-induction) on
   small leaves first (`e1_dbg_mmio_bridge`, then `e1_dma`).

## Alternative formal frameworks

- **EBMC** [ebmc] is an open SystemVerilog BMC tool with richer SVA
  support than Yosys' formal frontend. Worth piloting against the
  AXI-Lite property file once it exists; not a replacement for SBY in
  the main flow.
- **JasperGold** [jaspergold] and **VC Formal** [vcformal] are listed for
  positioning only. They are not in scope for the open-tool lane.

## Hardware fuzzing

| Framework | Maturity | RTL target | E1 relevance |
|---|---|---|---|
| RFUZZ [rfuzz] | UCB 2018, periodically refreshed | FIRRTL / Chisel | Applicable to Chipyard Rocket and Gemmini lanes. Useful baseline for coverage-guided RTL fuzzing. |
| DifuzzRTL [difuzzrtl] | KAIST 2021, MICRO best paper, periodically maintained | Verilog CPU cores | The natural fit for the selected Rocket or CVA6 CPU/AP. Differential fuzzing against Spike [spike] / Sail RISC-V [sail_riscv] is the right golden model. |
| TheHuzz [thehuzz] | USENIX Security 2022 | RTL CPU cores | Complements DifuzzRTL; instruction-fuzzing rather than register-level. |
| ProcessorFuzz [processorfuzz] | 2022 | RTL CPU cores | Reference; lower priority than DifuzzRTL. |

Recommended pilot: stand up DifuzzRTL against the CVA6 (or selected
Chipyard Rocket) RTL once the CPU/AP lane has generated artifacts. Use
Sail RISC-V as the golden model. Treat any divergence as a P0 bug.

## Property-based testing in cocotb

- **cocotb** [cocotb] is the test runner. Workstream A asks for "randomized
  cocotb/reference-model coverage."
- **cocotb-coverage** [cocotb_coverage] provides functional coverage
  (cover-points, cover-crosses) in Python. This is the right tool to add
  before claiming coverage in any release evidence.
- **Forastero** [forastero] and **pyuvm** [pyuvm] both layer UVM-style
  patterns on top of cocotb. Forastero is the lighter of the two and a
  reasonable fit for the e1_soc top-level testbench.
- **Hypothesis** [hypothesis] (Python) is the right framework for the
  *software* layers in `benchmarks/parsers/`, `compiler/runtime/`, and the
  scripts under `scripts/check_*.py`. PBT shrinkers expose schema-validation
  gaps that example-based unit tests miss.
- **Hedgehog** [hedgehog] is the Haskell analogue; reference only.

## Coverage reporting

Concrete gap (Workstream A): "Add coverage summaries for opcodes, MMIO
regions, response codes, IRQs, and AXI timing permutations."

Recommended approach:

1. Add cocotb-coverage cover-points per RTL block. Emit per-test JSON
   reports under `build/reports/coverage/<block>.json`.
2. Add a merger script that produces a UCIS-shaped JSON summary
   consumable by `scripts/check_*` gates.
3. Tie coverage thresholds to `verify/rtl_gap_work_order.yaml` so that a
   block cannot move out of "open work order" without coverage evidence.

## Reset and CDC

`verify/properties/` exists but is not wired into any .sby script. Reset
and CDC properties are easy to write (e.g., `assert property
(@(posedge clk) disable iff (!rst_n) ...)`) and have high catch rate. The
incremental cost is small; the unblocking value is large. Recommended
high-confidence addition.

## Differential simulation against a golden model

For the CPU lane, the standard pattern is:

1. Run the RTL CPU under Verilator with cocotb instrumentation.
2. Run Sail RISC-V [sail_riscv] or Spike [spike] in lockstep.
3. Compare architectural state at every commit point.
4. Treat any divergence as a P0 bug.

This is also the substrate over which DifuzzRTL adds coverage-guided
input generation. Recommended for the Phase B Rocket/CVA6 lift.

## Concrete actions ranked by confidence

| Action | Confidence | Effort | Unblocks |
|---|---|---|---|
| Add `smtbmc bitwuzla` engine line alongside `smtbmc z3` in every .sby. | High | Low | Workstream E Bitwuzla evaluation. |
| Add cocotb-coverage cover-points per block and a merge step. | High | Medium | Workstream A coverage gap. |
| Add reset-domain and CDC properties via `verify/properties/` to each .sby. | High | Low | Workstream A protocol property gap. |
| Write an AXI-Lite open-property file and apply it to `rtl/interconnect/` and `rtl/memory/`. | High | Medium | Workstream A protocol property gap. |
| Stand up Spike/Sail lockstep against CVA6/Rocket. | Medium (waits on CPU/AP lane) | Medium | Workstream B CPU/AP evidence. |
| Pilot DifuzzRTL on the same CPU lane. | Medium | Medium | Long-term CPU correctness. |
| Pilot EBMC on AXI-Lite properties. | Low (nice-to-have, SBY likely sufficient) | Medium | Solver/tool diversity. |
| Adopt Hypothesis for `benchmarks/parsers/` and `scripts/check_*` test suites. | High | Low | Software-quality. |
| Move from `mode bmc` to `mode prove` on small leaves once Bitwuzla is in CI. | Medium | Low | Unbounded proof evidence. |
