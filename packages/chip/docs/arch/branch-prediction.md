# Branch prediction contract

`rtl/cpu/bpu/` carries the synthesizable Branch Prediction Unit for the Eliza
E1 application processor. The BPU is decoupled from instruction fetch: a
Fetch Target Queue (FTQ) buffers predicted fetch blocks between the BPU and
the L1I, so that BPU stages can run ahead of fetch and emit prefetch hints in
the style of [FDIP](https://dl.acm.org/doi/10.5555/320080.320085) and
[XiangShan Kunminghu](https://github.com/OpenXiangShan/XiangShan/blob/kunminghu-v3/src/main/scala/xiangshan/Parameters.scala).

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

Each `ftq_entry_t` carries the prediction-time metadata needed for
production-style update/recovery: RAS speculative top plus top-entry restore
contents, TAGE/ITTAGE provider IDs, TAGE provider counter and low-confidence
bit, SC override direction, the global-history snapshot, and the mixed ITTAGE
history plus target/path-history components. Commit-time TAGE/SC/ITTAGE
training replays the resolved FTQ entry's prediction metadata so the backend
does not have to mirror provider IDs or predictor histories from decode/rename.

## Selected topology

The BPU shape is a scaled XiangShan Kunminghu derivative. Numbers come from
`rtl/cpu/bpu/bpu_pkg.sv` and are enforced by the evidence gate at the
thresholds called out in the right-most column. See
`docs/architecture-optimization/sota-2028/branch-predictors.md` for the SOTA
rationale.

| Component | Selected | 2028 minimum threshold | Rationale |
| --- | --- | --- | --- |
| FETCH_BLOCK_BYTES | 32 | 32 | 16 RVC inst/predict, matches Zen 5 / X925 / Lion Cove. |
| MAX_BR_PER_BLOCK | 2 | 1 | FTB/FTQ carry two in-block branch slots; a later conditional slot can redirect when the earlier conditional falls through. |
| FTQ_ENTRIES | 64 | 32 | Decouple BPU from fetch, FDIP-compatible. |
| UFTB_ENTRIES | 512 | 256 | Zero-bubble next-line predictor, above KMH 256. |
| UFTB_STEER_CONF_MIN | 2 | optional | uFTB-only steering requires repeated matching target/kind updates. |
| FTB_ENTRIES | 4096 | 2048 | BTB replacement, above KMH v2 floor; doubled after CBP/E1 working-set sweep. |
| FTB_WAYS | 4 | 4 | Match KMH/X925 set-associative footprint with invalid-first age-based replacement. |
| TAGE_TABLES | 5 | 4 | TAGE-SC-L stack on top of bimodal. |
| TAGE_ENTRIES_TABLE | 8192 | 4096 | CBP-5 floor plus R9 capacity sweep win. |
| TAGE_HIST_LEN | {8, 16, 44, 90, 195} | reach >= 100 | Geometric history, extended to 195 after mixed workload sweep. |
| TAGE_USE_ALT_ON_NA | 0 | optional | Alternate-provider path is implemented and swept; default awaits evidence. |
| BIM_ENTRIES | 16384 | 8192 | Base bimodal table. |
| SC_TABLES | 4 | 4 | Statistical corrector for low-confidence TAGE. |
| SC_ENTRIES_TABLE | 512 | 512 | Seznec CBP-5 baseline. |
| SC_LOCAL_HISTORY_BITS | 8 | optional | Local-history fold in the SC index; full-trace check improved weighted MPKI by 0.0163 versus disabled. |
| LOOP_ENTRIES | 64 | 32 | Loop-trip predictor. |
| ITTAGE_TABLES | 5 | 5 | Indirect target predictor. |
| ITTAGE_ENTRIES | {512, 512, 1024, 1024, 1024} | >= 1024 total | Indirect target capacity for JS/GPU dispatch. |
| ITTAGE_HIST_LEN | {4, 10, 20, 40, 80} | optional | Full-trace sweep improved weighted MPKI by 0.0502 with no reported regressions. |
| ITTAGE_USEFUL_RESET_PERIOD | 100000 | optional | ITTAGE useful-bit aging for stale indirect-target replacement. |
| ITTAGE_TARGET_HISTORY_SHIFT | 8 | optional | Target-history token starts at target bit 8; full-trace sweep improved weighted MPKI by 0.0822. |
| ITTAGE_PATH_HISTORY_BITS | 0 | optional | RTL/model support path-history mixing; capped sweeps currently regress, so default stays disabled. |
| RAS_ARCH_ENTRIES | 32 | 16 | Architectural depth. |
| RAS_SPEC_ENTRIES | 64 | 32 | Speculative depth with overflow counter. |

The uFTB stores the fast next-PC prediction plus the resolved branch kind,
call fall-through PC, and a small target confidence counter. FTB hits still
win the full arbitration path, but a confident uFTB-only hit can classify the
prediction as call/return/indirect; calls push the mirrored fall-through PC
into the speculative RAS and returns pop/use the RAS top when it is valid
instead of blindly using the stored target. Raw uFTB hits still count for PMU
visibility, but they do not steer fetch until matching target/kind updates
raise confidence to `UFTB_STEER_CONF_MIN`. uFTB replacement is invalid-first
and age-based so recent zero-bubble targets survive set churn.

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
| **E1 agent duty cycle (real RV64 trace)** | <= 1.0 | **MET**: 0.259 MPKI. Native `qemu-riscv64`+execlog trace of the llama.cpp agent loop (`benchmarks/cpu/branch/workloads/agent_loop.c`); see Workload trace pipeline below. |
| **E1 decode-heavy path (real RV64 trace)** | <= 1.0 | **MET**: 0.349 MPKI. Hard-branch (tokenizer/sampler/stream) variant of the same workload. |
| SPECint2017 intrate, geomean | <= 4.0 | `BLOCKED`: requires SPEC license + cycle-accurate gem5-XiangShan. |
| Geekbench 6 navigation | <= 6 | `BLOCKED`: closed benchmark. |
| Android UI (AOSP, ART/JIT) | <= 5 | `BLOCKED`: requires AsmDB/simpleperf trace ingestion. |
| Android cold-launch (Chrome/YouTube) | <= 8 | `BLOCKED`: requires AOSP system trace. |
| Linux kernel mix | <= 4 | `BLOCKED`: requires `simpleperf` capture on Linux-capable AP boot. |
| V8 JetStream2 indirect dispatch | <= 4% indirect misp | `BLOCKED`: requires JS-engine trace. |

The local cocotb MPKI harness (`benchmarks/cpu/branch/run_mpki.py`) measures
the BPU against synthetic and trace-replay workloads. The closed third-party
suites (SPEC/AOSP/JS) remain BLOCKED, but the E1's *own* duty cycle is no
longer blocked — see the workload trace pipeline below.

## Workload trace pipeline (native RV64)

The E1 spends its time in a looping multimodal agent on `llama.cpp`:
tokenize, run quantized GEMV, sample, parse a streamed response. That branch
behaviour is captured directly, on the native Linux x64 host, with no PMU
privileges and no Docker:

1. `benchmarks/cpu/branch/workloads/agent_loop.c` reproduces the branch
   behaviour of that loop — UTF-8/BPE tokenizer (string), int8 GEMV
   (predictable loops), top-k sampler (loops), streamed-JSON state machine
   (indirect dispatch). It is cross-compiled for `riscv64` so the trace is
   ISA-faithful to the E1 target (FTB/ITTAGE/RAS targets match silicon).
2. It runs under `qemu-riscv64` user mode with QEMU's `libexeclog` TCG plugin
   (`external/qemu-build`), one line per retired instruction.
3. `workload_trace.decode_execlog` reconstructs an exact branch-event stream
   (the next executed PC is ground truth for direction and indirect target)
   and writes a `.btrace.json` to the gitignored `external/workload-traces/`.

Capture with `make bpu-workload-trace` (`MODE=1` for the decode-heavy variant).

The headline result: **the E1 duty cycle is easy for branch prediction**
(0.26 MPKI balanced, 0.35 MPKI decode-heavy). LLM inference is dominated by
highly-regular loop control flow, so the predictor runs near its accuracy
floor — consistent with the workload's "throughput between calls is not the
bottleneck" character.

## Geometry tuning sweep

`benchmarks/cpu/branch/sweep.py` (`make bpu-sweep`) is the optimisation loop:
it runs the behavioural TAGE-SC-L+ITTAGE model under candidate `bpu_pkg.sv`
geometries over the trace set (real RV64 agent/IO workloads, synthetic hard
shapes, and the CBP-5 references) and ranks them by workload-weighted MPKI, writing
`docs/evidence/cpu_ap/bpu_sweep_results.json` and `…_leaderboard.md`. Each knob
maps one-to-one to a `bpu_pkg.sv` parameter, so a winning config is a direct
RTL proposal.

Full-trace validation of the current expanded workload set (weighted MPKI,
lower is better):

| Config | Weighted MPKI | Δ vs baseline | bpu_pkg.sv change |
| --- | --- | --- | --- |
| `baseline` | 10.9421 | — | current `bpu_pkg.sv` geometry |
| `pre_ittage_hist_long` | 11.0751 | +0.1329 | old ITTAGE history schedule |
| `tage_use_alt_on_na` | 11.7862 | +0.8440 | alternate-provider mode enabled |

**Decision: promote `ITTAGE_TARGET_HISTORY_SHIFT=8` and longer ITTAGE
histories.** Shift 8 first improved the full-trace weighted mix by 0.0822 MPKI
over the prior geometry; with shift 8 as baseline, the longer
`{4,10,20,40,80}` ITTAGE history schedule improved another 0.0502 MPKI. After
adding nested-loop, XOR-correlation, vtable-path, and interpreter-dispatch
synthetics plus phase-change, alias-thrash, GPU-occupancy, and RAS-exception
stressors, the old schedule is 0.1329 MPKI worse than current baseline.
Path-history variants remain disabled: the 50k capped sweep regressed the
weighted mix, so the shipped TAGE-SC-L+ITTAGE geometry now keeps target history
but leaves ITTAGE path history off.

The behavioural model now implements the statistical corrector (`sc.sv`) and
the ITTAGE target-history token parameters it sweeps, so the planning model is
a faithful TAGE-SC-L companion to the RTL for these knobs. Adaptive-SC-threshold
is available in the model as a tuning lever (`SC_ADAPTIVE`) and measured
neutral on this trace set; the RTL also implements bounded adaptive threshold
control.

SC local history stays enabled after a full-trace baseline-vs-disabled check
with the promoted shift-8 target history (`baseline` 5.5196 MPKI vs
`sc_no_local_hist` 5.5359). The win is concentrated in GPU/divergence and
dual-branch-block traces, which matches the E1 tuning objective while still
leaving the knob visible in the sweep for future general-workload retuning.

The alternate-provider TAGE path (`TAGE_USE_ALT_ON_NA`) is implemented and
swept but disabled by default. On the expanded full-trace set it regressed
weighted MPKI by 0.8440, mainly on alias-thrash, GPU divergence, and
interpreter-dispatch synthetics.

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
2. **Full two-taken/non-contiguous fetch** — current geometry parameterises
   `MAX_BR_PER_BLOCK = 2`, stores both FTB slots, carries both through the
   FTQ, and can redirect to a later conditional when the earlier conditional
   falls through. The remaining blocker is a true two-taken/non-contiguous
   fetch contract; the redirect bus still emits one next-PC per cycle.
3. **Commit-time predictor replay cleanup** — top-level TAGE/SC/ITTAGE
   updates replay FTQ histories, providers, and SC/TAGE confidence metadata by
   `resolve.ftq_idx`. The remaining cleanup is removing legacy directed-test
   provider mirrors from `bpu_resolve_t` once non-FTQ resolve injection paths
   are retired.
4. **Speculative history recovery precision** — on a redirect, current
   speculative direction and target histories rebuild from architectural
   history plus the resolved outcome. FTQ entries preserve prediction-time
   history snapshots, but top-level recovery does not yet restore from those
   snapshots and replay younger surviving predictions.
5. **L1I translation boundary** — `ftq_to_l1i_shim` lands the prefetch request
   on the cache agent's interface and the FDIP/L1I ready path has cocotb
   coverage. Real iTLB-on-receive translation remains in the cache domain.
6. **Real-trace MPKI evidence** — see Accuracy targets.
7. **Verilator/Yosys/SBY hosting** — the chip package has historically relied
   on Docker/Nix shells for these tools; the local oss-cad-suite checkout
   under `external/oss-cad-suite/` resolves them. `make bpu-lint`,
   `make cocotb-bpu`, and `make formal-bpu` fail closed with `STATUS: BLOCKED`
   when the suite is missing.
8. **Formal coverage for the FTQ and RAS** — yosys 0.64 (oss-cad-suite) does
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
| Behavioural model unit tests | `make bpu-model-test` | pytest (TAGE-SC-L+ITTAGE model) |
| Real RV64 workload trace | `make bpu-workload-trace` | `external/workload-traces/<name>.btrace.json` |
| Geometry tuning sweep | `make bpu-sweep` | `docs/evidence/cpu_ap/bpu_sweep_results.json`, `…_leaderboard.md` |

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
- `benchmarks/cpu/branch/bpu_model.py` — behavioural TAGE-SC-L+ITTAGE model
  (includes the statistical corrector, faithful to `sc.sv`).
- `benchmarks/cpu/branch/workloads/agent_loop.c` — RV64 llama.cpp agent-loop
  branch-behaviour workload.
- `benchmarks/cpu/branch/workload_trace.py` — QEMU execlog → exact branch
  trace decoder and `.btrace.json` reader/writer.
- `benchmarks/cpu/branch/capture_workload_trace.py` — cross-compile + qemu +
  decode capture pipeline.
- `benchmarks/cpu/branch/sweep.py` — geometry tuning sweep + leaderboard.
- `docs/evidence/cpu_ap/bpu_sweep_results.json`, `bpu_sweep_leaderboard.md` —
  sweep evidence.
- `generators/xiangshan/eliza-kunminghu-manifest.json` — BPU IP-pin manifest.
- `docs/generators/xiangshan/eliza-kunminghu-manifest.json` — historical
  manifest predating the IP-pin/whole-core split; both files are kept in
  lockstep via `scripts/check_branch_prediction.py`.
- `docs/evidence/cpu_ap/branch-prediction-params.json` — evidence emitted by
  `scripts/check_branch_prediction.py`.
- `docs/evidence/cpu_ap/pmu-event-alignment.json` — cross-domain PMU
  alignment evidence.
