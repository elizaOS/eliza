# Branch prediction contract

`rtl/cpu/bpu/` carries the synthesizable Branch Prediction Unit for the Eliza
E1 application processor. The BPU is decoupled from instruction fetch: a
Fetch Target Queue (FTQ) buffers predicted fetch blocks between the BPU and
the L1I, so that BPU stages can run ahead of fetch and emit prefetch hints in
the style of [FDIP](https://dl.acm.org/doi/10.5555/320080.320085) and
[XiangShan Kunminghu](https://github.com/OpenXiangShan/XiangShan/blob/kunminghu-v2/src/main/scala/xiangshan/Parameters.scala).

This document mirrors the contract style of `docs/arch/cpu-subsystem.md`. It
is the externally checkable description of the BPU shape, ISA-visible PMU
events, accuracy targets, and blockers. The fail-closed evidence gate is
`make branch-prediction-check` which writes
`docs/evidence/cpu_ap/branch-prediction-params.json`.

## Boundary

`rtl/cpu/bpu/bpu_top.sv` exposes a structured lookup/resolve interface:

| Direction | Signal | Purpose |
| --- | --- | --- |
| in  | `lkp_valid`, `lkp_pc` | Drive a single PC into the BPU per cycle. |
| out | `pred_valid`, `pred` (`bpu_lookup_t`) | Aggregated prediction. |
| in  | `fetch_pop` | Fetch dequeue strobe. |
| out | `fetch_valid`, `fetch_entry` (`ftq_entry_t`) | Top of the FTQ. |
| in  | `resolve` (`bpu_resolve_t`) | Resolver feedback from the back-end. |
| in  | `csr_re`, `csr_addr` | Read port for the 64-bit PMU counters. |
| out | `csr_rdata`, `pmu_strb` | Counter value and event strobes. |

Both the prediction and the resolve buses are timed to a single cycle in the
current geometry; the FTQ is the decoupling structure between the BPU and the
fetch engine.

## Selected topology

The BPU shape is a scaled XiangShan Kunminghu derivative. Numbers come from
`rtl/cpu/bpu/bpu_pkg.sv` and are enforced by the evidence gate at the
thresholds called out in the right-most column. See
`docs/architecture-optimization/sota-2028/branch-predictors.md` for the SOTA
rationale.

| Component | Selected | 2028 minimum threshold | Rationale |
| --- | --- | --- | --- |
| FETCH_BLOCK_BYTES | 32 | 32 | 16 RVC inst/predict, matches Zen 5 / X925 / Lion Cove. |
| MAX_BR_PER_BLOCK | 2 | 1 | 2 taken/cycle target by 2028, MVP 1-taken acceptable. |
| FTQ_ENTRIES | 64 | 32 | Decouple BPU from fetch, FDIP-compatible. |
| UFTB_ENTRIES | 512 | 256 | Zero-bubble next-line predictor, above KMH 256. |
| FTB_ENTRIES | 2048 | 2048 | BTB replacement, KMH v2 floor. |
| FTB_WAYS | 4 | 4 | Match KMH/X925 set-associative footprint. |
| TAGE_TABLES | 5 | 4 | TAGE-SC-L stack on top of bimodal. |
| TAGE_ENTRIES_TABLE | 4096 | 4096 | CBP-5 floor; KMH-class. |
| TAGE_HIST_LEN | {8, 13, 32, 64, 119} | reach >= 100 | Geometric history. |
| BIM_ENTRIES | 16384 | 8192 | Base bimodal table. |
| SC_TABLES | 4 | 4 | Statistical corrector for low-confidence TAGE. |
| SC_ENTRIES_TABLE | 512 | 512 | Seznec CBP-5 baseline. |
| LOOP_ENTRIES | 64 | 32 | Loop-trip predictor. |
| ITTAGE_TABLES | 5 | 5 | Indirect target predictor. |
| ITTAGE_ENTRIES | {256, 256, 512, 512, 512} | >= 1024 total | Matches KMH-v2. |
| RAS_ARCH_ENTRIES | 32 | 16 | Architectural depth. |
| RAS_SPEC_ENTRIES | 64 | 32 | Speculative depth with overflow counter. |

## PMU events (Zihpm)

`pmu_event_e` in `bpu_pkg::pmu_event_e` is the canonical event encoding. The
BPU exports `pmu_strb` and `csr_rdata` for SoC-level Zihpm integration; CSR
counter indices are the enum value of the event.

The BPU enum is ordered so the mapping into `zihpm_pkg::hpm_event_e` is a
pure +1 offset (zihpm reserves id 0 for the "no event" sentinel). The
translation is `bpu_pkg::bpu_pmu_to_hpm(pmu_id) = pmu_id + 1`.

| BPU id | Event | zihpm id | zihpm enum | Description |
| --- | --- | --- | --- | --- |
| 0 | `PMU_BR_PRED` | 1 | `EVT_BR_PRED` | Total predictions emitted. |
| 1 | `PMU_BR_TAKEN` | 2 | `EVT_BR_TAKEN` | Predictions where the direction was taken. |
| 2 | `PMU_BR_MISP` | 3 | `EVT_BR_MISP` | Mispredictions reported by the resolver. |
| 3 | `PMU_BR_COND` | 4 | `EVT_BR_COND` | Conditional branches predicted. |
| 4 | `PMU_BR_COND_MISP` | 5 | `EVT_BR_COND_MISP` | Conditional branch mispredictions. |
| 5 | `PMU_BR_IND` | 6 | `EVT_BR_IND` | Indirect branches predicted. |
| 6 | `PMU_BR_IND_MISP` | 7 | `EVT_BR_IND_MISP` | Indirect branch mispredictions. |
| 7 | `PMU_BR_CALL` | 8 | `EVT_BR_CALL` | Call predictions. |
| 8 | `PMU_BR_RET` | 9 | `EVT_BR_RET` | Return predictions. |
| 9 | `PMU_BR_RET_MISP` | 10 | `EVT_BR_RET_MISP` | Return mispredictions. |
| 10 | `PMU_RAS_OVERFLOW` | 11 | `EVT_RAS_OVERFLOW` | RAS push into a full speculative stack. |
| 11 | `PMU_RAS_UNDERFLOW` | 12 | `EVT_RAS_UNDERFLOW` | RAS pop from an empty speculative stack. |
| 12 | `PMU_FTQ_FULL` | 13 | `EVT_FTQ_FULL` | FTQ full strobe. |
| 13 | `PMU_FTQ_EMPTY` | 14 | `EVT_FTQ_EMPTY` | FTQ empty strobe. |
| 14 | `PMU_FETCH_BUBBLE` | 15 | `EVT_FETCH_BUBBLE` | Fetch popped while FTQ was empty. |
| 15 | `PMU_FTB_MISS` | 16 | `EVT_BTB_MISS` | FTB read missed. |
| 16 | `PMU_UFTB_HIT` | 17 | `EVT_UFTB_HIT` | uFTB read hit. |
| 17 | `PMU_TAGE_ALLOC` | 18 | `EVT_TAGE_ALLOC` | TAGE allocated a new entry. |
| 18 | `PMU_LOOP_HIT` | 19 | `EVT_LOOP_HIT` | Loop predictor produced a high-confidence prediction. |
| 19 | `PMU_SC_OVERRIDE` | 20 | `EVT_SC_OVERRIDE` | SC overrode TAGE on a low-confidence prediction. |

These are visible to Linux `perf` via `Zihpm` event selectors documented in
`docs/evidence/cpu_ap/branch-prediction-params.json`. The OoO cluster wires
the BPU's `pmu_strb` bit `i` onto its event bus at position
`bpu_pmu_to_hpm(i)` so the Zihpm counters see exactly one strobe per BPU
event firing, with no further translation logic in the integration top.

## Accuracy targets

| Workload | MPKI ceiling | Status |
| --- | --- | --- |
| TAGE-SC-L on CBP-5 synthetic trace | <= 4.5 | local cocotb harness in `benchmarks/cpu/branch/`. |
| SPECint2017 intrate, geomean | <= 4.0 | `BLOCKED`: requires SPEC license + cycle-accurate gem5-XiangShan. |
| Geekbench 6 navigation | <= 6 | `BLOCKED`: closed benchmark. |
| Android UI (AOSP, ART/JIT) | <= 5 | `BLOCKED`: requires AsmDB/simpleperf trace ingestion. |
| Android cold-launch (Chrome/YouTube) | <= 8 | `BLOCKED`: requires AOSP system trace. |
| Linux kernel mix | <= 4 | `BLOCKED`: requires `simpleperf` capture on Linux-capable AP boot. |
| V8 JetStream2 indirect dispatch | <= 4% indirect misp | `BLOCKED`: requires JS-engine trace. |

The local cocotb MPKI harness (`benchmarks/cpu/branch/run_mpki.py`) measures
the BPU against synthetic and trace-replay workloads. Real-workload numbers
remain BLOCKED until SPEC/AOSP/JS evidence is in place.

## Cross-domain contracts

Two interfaces leave the BPU domain.

### PMU → Zihpm

The BPU emits one strobe per cycle into `pmu_strb[PMU_EVENTS-1:0]`. The OoO
domain consumes it through `rtl/cpu/csr/bpu_to_zihpm_remap.sv`, which lands
each strobe into its Zihpm-event-bus slot. The BPU enum is locked so the
mapping is a pure `+1` offset, with the helper `bpu_pkg::bpu_pmu_to_hpm()`
encoding the rule.

| BPU side | OoO side |
| --- | --- |
| `rtl/cpu/bpu/bpu_pkg.sv` (`pmu_event_e`, `bpu_pmu_to_hpm()`) | `rtl/cpu/csr/zihpm.sv` (`hpm_event_e`) |
| 20-bit `pmu_strb` from `bpu_top.pmu_strb` | 256-bit zihpm event bus driven by `bpu_to_zihpm_remap` |
| Counter readout: `csr_addr` 0..19 → 64-bit counter | OS-visible Zihpm CSRs `mhpmcounter3..15` |

Coordination evidence is produced by
`scripts/check_pmu_event_alignment.py` (writes
`docs/evidence/cpu_ap/pmu-event-alignment.json`).

### FTQ → L1I

The BPU writes predicted fetch blocks into the FTQ and emits a downstream
prefetch request via `rtl/cpu/bpu/ftq_to_l1i_shim.sv`. The cache domain
consumes `e1_ftq_to_l1i_pkg::ftq_prefetch_req_t` (40-bit physical line +
3-bit confidence + branch-target hint) on a single-cycle valid/ready
handshake with a separate flush strobe for misprediction recovery.

The shim performs three translations:

1. 39-bit Sv39 virtual `target_pc` → 40-bit physical line address (assumes
   identity V→P at this stage; real translation lives on the cache side).
2. `br_kind_e` → 3-bit confidence (`BR_NONE=0`, `BR_COND=4`, `BR_CALL=5`,
   `BR_RET=6`).
3. `branch_target` = `fetch_entry.taken`.

The cluster top (`rtl/cpu/cluster/e1_cluster_top.sv`) wires the shim
between `bpu_top.fetch_entry` and the cache domain.

## Blockers

1. **XiangShan upstream licensing** — Mulan PSL v2; resolved by adoption,
   tracked via `generators/xiangshan/eliza-kunminghu-manifest.json`
   (BPU IP pin) and `generators/chipyard/eliza-kunminghu-manifest.json`
   (whole-core selection, owned by the OoO domain).
2. **Two-taken-per-cycle** — current geometry parameterises
   `MAX_BR_PER_BLOCK = 2` but the prediction pipeline only emits one taken
   branch per cycle. Lifting this to two requires a dual-port FTB read path
   and a non-contiguous fetch contract.
3. **L1I prefetch path** — `ftq_to_l1i_shim` lands the prefetch request on
   the cache agent's interface, but the cache-side prefetch engine and the
   iTLB-on-receive translation remain in the cache domain.
4. **Real-trace MPKI evidence** — see Accuracy targets.
5. **Verilator/Yosys/SBY hosting** — the chip package has historically relied
   on Docker/Nix shells for these tools; the local oss-cad-suite checkout
   under `external/oss-cad-suite/` resolves them. `make bpu-lint`,
   `make cocotb-bpu`, and `make formal-bpu` fail closed with `STATUS: BLOCKED`
   when the suite is missing.
6. **Formal coverage for the FTQ and RAS** — yosys 0.64 (oss-cad-suite) does
   not accept struct typedefs in module port lists, and its async-reset
   handling lets the BMC pick arbitrary initial values for reset-driven
   flops. Both formal harnesses fail closed with named yosys limitations and
   the cocotb regression (33/33 across 9 modules) carries functional
   coverage in the interim.

## Verification surface

| Gate | Command | Output |
| --- | --- | --- |
| Parameter geometry | `make branch-prediction-check` | `docs/evidence/cpu_ap/branch-prediction-params.json` |
| Cross-domain PMU IDs | `make pmu-event-alignment-check` | `docs/evidence/cpu_ap/pmu-event-alignment.json` |
| Verilator strict lint | `make bpu-lint` | `build/reports/bpu/lint-status.yaml` |
| Cocotb regression | `make cocotb-bpu` | `verify/cocotb/bpu/results/*.xml` |
| SymbiYosys formal | `make formal-bpu` | `build/reports/bpu/formal-status.yaml` |
| MPKI eval (RTL, cocotb) | `make mpki-eval-rtl` | `docs/evidence/cpu_ap/mpki_results_synthetic.json` |
| MPKI eval (model only) | `make mpki-eval-model` | `benchmarks/results/branch-prediction-mpki-model.json` |
| MPKI vs CBP-5 table | — | `docs/evidence/cpu_ap/mpki_synthetic_vs_cbp5_reference.md` |

## Files

- `rtl/cpu/bpu/bpu_pkg.sv` — parameter and type package.
- `rtl/cpu/bpu/bimodal.sv`, `tage_table.sv`, `tage.sv` — TAGE direction.
- `rtl/cpu/bpu/sc.sv` — statistical corrector.
- `rtl/cpu/bpu/loop_predictor.sv` — loop predictor.
- `rtl/cpu/bpu/ittage.sv` — indirect target predictor.
- `rtl/cpu/bpu/ftb.sv`, `uftb.sv` — fetch target buffer + zero-bubble buddy.
- `rtl/cpu/bpu/ras.sv` — return address stack.
- `rtl/cpu/bpu/ftq.sv` — fetch target queue.
- `rtl/cpu/bpu/bpu_csr.sv` — PMU counters and useful-bit reset.
- `rtl/cpu/bpu/bpu_top.sv` — integration top.
- `rtl/cpu/bpu/ftq_to_l1i_shim.sv` — translation to the cache domain's
  L1I-prefetch interface.
- `verify/cocotb/bpu/` — cocotb unit and integration tests
  (9 wrappers / 33 tests).
- `verify/formal/bpu/` — SymbiYosys formal harnesses.
- `benchmarks/cpu/branch/` — MPKI harness and synthetic traces
  (8 synthetic generators).
- `generators/xiangshan/eliza-kunminghu-manifest.json` — BPU IP-pin manifest.
- `docs/generators/xiangshan/eliza-kunminghu-manifest.json` — historical
  manifest predating the IP-pin/whole-core split; both files are kept in
  lockstep via `scripts/check_branch_prediction.py`.
- `docs/evidence/cpu_ap/branch-prediction-params.json` — evidence emitted by
  `scripts/check_branch_prediction.py`.
- `docs/evidence/cpu_ap/pmu-event-alignment.json` — cross-domain PMU
  alignment evidence.
