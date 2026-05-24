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
| MAX_BR_PER_BLOCK | 2 | 1 | FTB/FTQ carry two in-block branch slots; same-block fall-through plus later taken conditionals emit two fetch segments. |
| FTQ_ENTRIES | 64 | 32 | Decouple BPU from fetch, FDIP-compatible. |
| UFTB_ENTRIES | 512 | 256 | Zero-bubble next-line predictor, above KMH 256. |
| UFTB_STEER_CONF_MIN | 2 | optional | uFTB-only steering requires repeated matching target/kind updates. |
| FTB_ENTRIES | 4096 | 2048 | BTB replacement, above KMH v2 floor; doubled after CBP/E1 working-set sweep. |
| FTB_WAYS | 4 | 4 | Match KMH/X925 set-associative footprint with invalid-first age-based replacement. |
| BPU_WORKLOAD_CLASS_W | 2 | optional | Runtime predictor phase class folded into the predictor context for GPU/ML/general partitioning. |
| L2_FTB_ENTRIES | 8192 | 4096 | Delayed target refill tier for L1 FTB conflict/capacity misses. |
| L2_FTB_WAYS | 8 | 8 | Deeper associativity keeps GPU driver/runtime dispatch targets resident after L1 churn. |
| TAGE_TABLES | 5 | 4 | TAGE-SC-L stack on top of bimodal. |
| TAGE_ENTRIES_TABLE | 8192 | 4096 | CBP-5 floor plus R9 capacity sweep win. |
| TAGE_HIST_LEN | {8, 16, 44, 90, 195} | reach >= 100 | Geometric history, extended to 195 after mixed workload sweep. |
| TAGE_USE_ALT_ON_NA | 0 | optional | Static global alternate-provider mode regresses; adaptive chooser below is used instead. |
| TAGE_ALT_ON_NA_ENTRIES | 1024 | optional | Adaptive per-PC/provider use-alt chooser; capped 61-config sweep improved weighted MPKI by 0.1036. |
| BIM_ENTRIES | 16384 | 8192 | Base bimodal table. |
| SC_TABLES | 6 | 4 | Wider statistical corrector promoted by full-trace finalist sweep. |
| SC_ENTRIES_TABLE | 1024 | 512 | Doubled SC capacity for low-confidence TAGE corrections. |
| SC_THRESH_INIT | 6 | optional | Lower SC threshold from the `sc_wide_thresh6` finalist. |
| SC_LOCAL_HISTORY_BITS | 8 | optional | Local-history fold in the SC index; full-trace check improved weighted MPKI by 0.0163 versus disabled. |
| H2P_ENABLE | 1 | optional | Perceptron/H2P-style sidecar is enabled after the capped GPU-weighted sweep; disabling it regresses weighted MPKI by 1.3510 on the expanded trace set. |
| H2P_ENTRIES | 1024 | optional | PC-indexed signed-weight rows for the H2P sidecar; promoted after the stratified sweep beat the prior 512-row geometry by 0.3599 weighted MPKI. |
| H2P_HIST_LEN | 48 | optional | Global-history dot-product length for the H2P sidecar; shorter than the prior 64-bit schedule to reduce stale phase correlation. |
| H2P_TARGET_HIST_LEN | 0 | optional | Sweepable target-history feature slice for multi-perspective H2P; default-off after the expanded GPU/general workload sweep. |
| H2P_PATH_HIST_LEN | 0 | optional | Sweepable path-history feature slice for multi-perspective H2P; default-off after the expanded GPU/general workload sweep. |
| H2P_THRESHOLD | 36 | optional | H2P override/training margin. |
| H2P_LOWCONF_ONLY | 0 | optional | Sweepable guard that restricts H2P to weak TAGE providers; default-off because it regressed the stratified mix by 0.6982. |
| H2P_META_ENABLE | 0 | optional | RTL/model per-PC chooser for H2P overrides; default-off because the latest smoke sweep was not GPU/control neutral. |
| H2P_META_ENTRIES | 1024 | optional | H2P chooser entries. |
| H2P_META_CTR_W | 3 | optional | Signed H2P chooser counter width. |
| LOCAL_DIR_ENABLE | 1 | optional | Short local-direction sidecar is enabled behind a learned chooser. |
| LOCAL_DIR_META_ENABLE | 1 | optional | Learned chooser for the local-direction sidecar is enabled; disabling it regresses weighted MPKI by 0.5788, including GPU nested reconvergence. |
| LOOP_ENTRIES | 64 | 32 | Loop-trip predictor. |
| LOOP_PATH_SIG_W | 8 | 8 | Target-context loop signature separates same-PC loop entries reached through different indirect/call paths without changing during ordinary loop iterations. |
| LOOP_IMLI_ENABLE | 0 | optional | IMLI-style loop-iteration-history signature is implemented but default-off because the current best variant regresses GPU reconvergence. |
| LOOP_IMLI_HIST_W | 16 | optional | Loop-exit iteration-history storage width for IMLI experiments. |
| LOOP_IMLI_TOKEN_W | 4 | optional | Per-loop-exit token width used to fold loop PC and observed trip count. |
| ITTAGE_TABLES | 5 | 5 | Indirect target predictor. |
| ITTAGE_ENTRIES | {1024, 1024, 2048, 2048, 2048} | >= 1024 total | Indirect target capacity; expanded 50K sweep ranked the larger tier first. |
| ITTAGE_WAYS | 2 | optional | Set-associative indirect-target storage reduces alias pressure from hot dispatch tables. |
| ITTAGE_HIST_LEN | {4, 10, 20, 40, 80} | optional | Keeps the enforced >=80 indirect-history reach; the shorter {4,8,13,16,32} study result is not production-compliant despite a tiny capped-sweep win. |
| ITTAGE_TAG_W | 11 | optional | Wider indirect-target tags reduce false hits/alias pressure; 50K exhaustive sweep found no per-trace regressions. |
| ITTAGE_USEFUL_RESET_PERIOD | 100000 | optional | ITTAGE useful-bit aging for stale indirect-target replacement. |
| ITTAGE_TARGET_HISTORY_TOKEN_BITS | 5 | 5 | Five-bit folded target tokens were promoted after the expanded capped sweep improved weighted MPKI without reported GPU regressions. |
| ITTAGE_TARGET_HISTORY_SHIFT | 8 | optional | Target-history token starts at target bit 8; full-trace sweep improved weighted MPKI by 0.0822. |
| ITTAGE_PATH_HISTORY_BITS | 64 | optional | Path-history mixing is enabled with 8-bit folded path tokens after the post-associativity capped sweep found no per-trace regressions. |
| RAS_ARCH_ENTRIES | 32 | 16 | Architectural depth. |
| RAS_SPEC_ENTRIES | 64 | 32 | Speculative depth with overflow counter. |

The uFTB stores the fast next-PC prediction plus the resolved branch kind,
call fall-through PC, and a small target confidence counter. FTB hits still
win the full arbitration path, but a confident uFTB-only hit can classify the
prediction as call/return/indirect/direct; calls push the mirrored fall-through PC
into the speculative RAS and returns pop/use the RAS top when it is valid
instead of blindly using the stored target. Raw uFTB hits still count for PMU
visibility, but they do not steer fetch until matching target/kind updates
raise confidence to `UFTB_STEER_CONF_MIN`. uFTB lookup and update are both
fetch-block-keyed, so nonzero-offset branches train the same fast entry the
next block lookup will consult. FTB/uFTB replacement is invalid-first and
age-based so recent zero-bubble targets survive set churn; age maintenance is
touched-set only rather than a global all-set sweep.

Every BPU lookup and resolve carries `bpu_context_t` `{asid, vmid, priv,
secure, workload_class}`. The workload class is a software/runtime-visible
phase hook for partitioning broad predictor behavior across general CPU, GPU
driver/launch, and ML-runtime control streams without changing virtual PCs.
FTB, uFTB, and L2 FTB entries store the context and fold a compact context
hash into their index/tag functions, while `bpu_top` presents a context-mixed
PC to TAGE, SC, bimodal, loop, and ITTAGE so direction and local history state
are not shared solely by virtual PC. FTQ entries retain the lookup context and
commit-time replay is context-checked before using the
saved provider/history metadata. `bpu_flush_t` is the explicit software or
integration invalidation hook; it blocks same-cycle predictor updates,
invalidates target-array entries, drops FTQ contents and pending L2 requests,
and clears speculative/architectural histories plus RAS state.

The L1 FTB is backed by an 8-way L2 FTB. Resolver updates train both tiers;
an L1 FTB miss issues a one-cycle-delayed L2 lookup, and a matching non-stale
L2 response refills/promotes the complete branch-block entry back into L1.
Redirects carry a BPU epoch, so delayed responses from flushed lookups are
dropped instead of repopulating wrong-path targets. L2 hits for always-taken
call/indirect classes, strongly-taken conditionals, and request-snapshot
returns patch the live FTQ entry and emit `late_redirect_valid/pc/ftq_idx`,
discarding younger FTQ entries from that patched point. Conditional patches are
gated by a delayed bimodal strong-taken check; weak conditionals remain
refill-only. Return patches use the RAS top captured with the L2 miss request
and are suppressed when the uFTB already popped the return, avoiding a delayed
double-pop.

The behavioural MPKI model includes the same delayed target tier as a separate
`L2_FTB_ENTRIES` store with `l2_ftb_off/small/big` sweep knobs. The expanded
50K capped workload objective includes `synthetic:l2_ftb_target_pressure`, a
6144-site taken-target trace that exceeds L1 FTB capacity but fits the default
L2. Baseline scores `36.7571` weighted MPKI; disabling L2 scores `38.9826`,
driven by a `+100.0000` MPKI regression on the target-pressure trace. A
16384-entry L2 ties the default.

## PMU events (Zihpm)

`pmu_event_e` in `bpu_pkg::pmu_event_e` is the canonical event encoding. The
BPU exports `pmu_strb` and `csr_rdata` for SoC-level Zihpm integration; CSR
counter indices are the enum value of the event.

The BPU enum currently lands in the branch Zihpm block at a +1 offset because
Zihpm reserves id 0 for the "no event" sentinel. Integration still uses the
explicit `rtl/cpu/csr/bpu_to_zihpm_remap.sv` adapter, which rewires by event
name and binds BPU-side FTB naming to the published BTB Zihpm names.

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
| 20 | `PMU_H2P_OVERRIDE` | 21 | `EVT_H2P_OVERRIDE` | H2P produced the effective direction override after SC arbitration. |
| 21 | `PMU_L2_FTB_HIT` | 22 | `EVT_L2_BTB_HIT` | Delayed L2 FTB lookup hit and was eligible to refill L1. |
| 22 | `PMU_L2_FTB_MISS` | 23 | `EVT_L2_BTB_MISS` | Delayed L2 FTB lookup missed after an L1 FTB miss. |
| 23 | `PMU_TWO_AHEAD_REDIRECT` | 24 | `EVT_TWO_AHEAD_REDIRECT` | Bounded two-ahead target-block lookup emitted redirect lane 1. |
| 24 | `PMU_LOCAL_DIR_OVERRIDE` | 25 | `EVT_LOCAL_DIR_OVERRIDE` | Local direction sidecar supplied the effective conditional direction. |
| 25 | `PMU_META_TRAIN` | 26 | `EVT_BPU_META_TRAIN` | H2P/local-direction meta chooser trained because sidecar and base differed. |
| 26 | `PMU_L2_FTB_LATE_REDIRECT` | 27 | `EVT_L2_BTB_LATE_REDIRECT` | Delayed L2 FTB hit patched the FTQ and emitted a late redirect. |

These are visible to Linux `perf` via `Zihpm` event selectors documented in
`docs/evidence/cpu_ap/branch-prediction-params.json`. The OoO cluster wires
the BPU's `pmu_strb` bit `i` onto its event bus at position
`bpu_pmu_to_hpm(i)` so the Zihpm counters see exactly one strobe per BPU
event firing, with no further translation logic in the integration top.

## Accuracy targets

| Workload | MPKI ceiling | Status |
| --- | --- | --- |
| TAGE-SC-L on CBP-5 synthetic trace | <= 4.0 | RTL evidence present, target not met: aggregate RTL MPKI is above the 2028 target in `docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json`. |
| **E1 agent duty cycle (real RV64 trace)** | <= 1.0 | `PREFIX-ONLY`: RTL replay evidence exists in `docs/evidence/cpu_ap/mpki_results_workload_rtl.json`, but `branch_replay_cap` is non-null, so this is coverage evidence rather than a full-trace MPKI claim. |
| **E1 decode-heavy path (real RV64 trace)** | <= 1.0 | `PREFIX-ONLY`: same capped workload replay boundary; full-trace target-met status remains blocked until `branch_replay_cap` is null and thresholds pass. |
| SPECint2017 intrate, geomean | <= 4.0 | `BLOCKED`: requires SPEC license + cycle-accurate gem5-XiangShan. |
| Geekbench 6 navigation | <= 6 | `BLOCKED`: closed benchmark. |
| Android UI (AOSP, ART/JIT) | <= 5 | `BLOCKED`: requires AsmDB/simpleperf trace ingestion. |
| Android cold-launch (Chrome/YouTube) | <= 8 | `BLOCKED`: requires AOSP system trace. |
| Linux kernel mix | <= 4 | `BLOCKED`: requires `simpleperf` capture on Linux-capable AP boot. |
| V8 JetStream2 indirect dispatch | <= 4% indirect misp | `BLOCKED`: requires JS-engine trace. |

The local cocotb MPKI harness (`benchmarks/cpu/branch/run_mpki.py`) measures
the BPU against synthetic and trace-replay workloads. The closed third-party
suites (SPEC/AOSP/JS) remain BLOCKED. The E1 duty-cycle replay currently uses
a deterministic branch prefix cap for turnaround, so it is useful regression
coverage but not a full-trace target-met claim.

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
The checked workload inventory currently contains twenty QEMU-RV64 traces:
`agent_loop`, `agent_decode`, `http_parser`, `text_log`, `file_tlv`,
`video_blocks`, `audio_frames`, `build_compiler_proxy`, `compression_proxy`,
`crypto_packet_proxy`, `database_btree_proxy`, `gpu_control_proxy`,
`browser_layout_proxy`, `kernel_syscall_proxy`, `gc_runtime_proxy`,
`gpu_memory_residency_proxy`, `gpu_irq_fence_scheduler_proxy`,
`nn_delegate_fallback_proxy`, `mobile_ui_frame_scheduler_proxy`, and
`wasm_jit_osr_proxy`. The RTL workload evidence file
`mpki_results_workload_rtl.json` replays all twenty as
deterministic prefixes with `branch_replay_cap=5000`; this is coverage evidence
for the real-trace ingestion path, not a full-trace MPKI claim.
The committed provenance index
`docs/evidence/cpu_ap/bpu-workload-trace-manifest.json` hashes every staged
`.btrace.json`, records the full source instruction/branch counts, and names the
still-missing external suites: SPEC2017, AOSP system/server UI, browser/JS
engine, and production GPU driver/runtime traces. `make
bpu-workload-trace-manifest-check` validates the index, and
`make branch-prediction-check` cross-checks it against
`mpki_results_workload_rtl.json`.

The `.btrace.json` row schema now preserves BPU context fields alongside every
branch (`asid`, `vmid`, `priv`, `secure`, and `workload_class`). The capture
CLI can stamp those fields, and the planning model folds them through the same
context-PC hash shape as RTL. Existing five-column traces remain readable with
zero context.
The evidence gate is fail-closed for positive workload claims: a future
workload MPKI promotion must include `class_bucket_promotion` with non-regressing
`general` and `gpu_control` buckets, so GPU/control phases cannot be hidden by
an aggregate MPKI win.

Current RTL workload replay is **capped-prefix coverage evidence**, not a
full-trace target-met result. The checked `mpki_results_workload_rtl.json`
aggregate is 93.796454 MPKI across twenty deterministic 5,000-branch prefixes
(`branch_replay_cap=5000`); `agent_decode` is 82.622383 MPKI, `agent_loop` is
58.606924 MPKI, and the new GPU/mobile/NN/WASM proxies are included in the
same RTL artifact. The artifact now records `replay_fraction=0.003910`
(`100,000` replayed branches out of `25,574,792` source branches) plus
per-workload replay fractions, so the capped/full boundary is visible in the
load-bearing JSON rather than only in prose. Full-trace, low-MPKI workload
claims remain disabled until
uncapped RTL replay evidence is generated and passes the branch-prediction gate.
Use `make mpki-eval-rtl WORKLOAD_WINDOW_MODE=stratified` or the shortcut
`make mpki-eval-rtl-stratified` for capped RTL replay that samples early,
middle, and late trace phases instead of the deterministic prefix. Use
`make mpki-eval-rtl-full` for the uncapped RTL replay path (`WORKLOAD_MAXBR=0`).

## Geometry tuning sweep

`benchmarks/cpu/branch/sweep.py` (`make bpu-sweep`) is the optimisation loop:
it runs the behavioural TAGE-SC-L+ITTAGE model under candidate `bpu_pkg.sv`
geometries over the trace set (real RV64 agent/IO workloads, synthetic hard
shapes, and the CBP-5 references) and ranks them by workload-weighted MPKI, writing
`docs/evidence/cpu_ap/bpu_sweep_results.json` and `…_leaderboard.md`. Each knob
maps one-to-one to a `bpu_pkg.sv` parameter, so a winning config is a direct
RTL proposal.
For capped turnaround runs, `WINDOW_MODE=windows`, `stratified`, or `all` makes
the harness evaluate middle/late/stratified slices instead of only a prefix,
which gives GPU/control and phase-change traces a better anti-overfit signal.
Use `make bpu-sweep-full` for the full-trace model sweep path (`MAXBR=0`), and
pass `CONFIGS="baseline <candidate> ..."` to keep long sweeps focused.
The checked full-trace shard target, `make bpu-sweep-full-proxy-shard`, runs
baseline versus `h2p_off` over the five new GPU/mobile/NN/WASM proxy traces
without a branch cap and writes
`docs/evidence/cpu_ap/bpu_sweep_full_proxy_shard.json`.
The companion `make bpu-sweep-full-io-media-shard` target runs the uncapped
HTTP/text/file/video/audio shard over `baseline`, `h2p_off`, and
`h2p_lowconf_only`; the guarded H2P candidate wins that shard at `39.4707`
weighted MPKI versus baseline `40.2076` and `h2p_off` `39.9444`. It is not the
default because the broader `100k` stratified mixed-workload probe still favors
baseline (`42.3553` versus `42.9139` for `h2p_lowconf_only`) on correlated and
control-flow synthetic guardrails. `make bpu-sweep-full-system-gpu-shard`
covers the uncapped `gpu_control`, GC-runtime, syscall, and B-tree shard; guarded
H2P wins there too (`37.6255` versus baseline `38.0666` and `h2p_off`
`37.8209`). `make bpu-sweep-full-browser-build-crypto-shard` covers the
uncapped browser-layout, build/compiler, and crypto shard; guarded H2P wins
there with no per-trace regressions (`48.5761` versus baseline `50.1515` and
`h2p_off` `48.9479`).

The synthetic set is deliberately broad enough to catch overfitting: regular
GPU tile loops, SIMT divergence/reconvergence, GPU command processing and
command-buffer validation, interpreter/JIT dispatch, vtable/path-correlated
indirects, hash-probe/inline-cache chains, work-stealing queues, allocator/GC
barriers, alias thrash, phase changes, workload-class phase aliasing, dual
in-block branches, and RAS exception/tail-call mismatches.

The current checked behavioural sweep is a capped optimisation aid, not a
full-trace claim. It uses stratified `max_branches_per_trace=1000` windows over
the expanded twenty-trace QEMU workload set, synthetic hard shapes, and CBP-5
samples in `docs/evidence/cpu_ap/bpu_sweep_results.json`; lower weighted MPKI
is better. The separate full-proxy shard is uncapped (`max_branches_per_trace=0`)
and currently keeps baseline ahead of `h2p_off` (`49.5413` versus `49.5932`
weighted MPKI), but it covers only the five proxy traces and is not a substitute
for a full twenty-trace sweep or uncapped RTL replay.
The artifact also records ITTAGE hit, target-used, weak-yield, update,
allocation, weak-target replacement, victim replacement, provider-eviction, and
useful-aging counters per trace and in per-config totals so indirect-target
chooser and replacement behavior is visible in every checked sweep. It also
records timing-model counters for deferred SC, H2P, local-direction, ITTAGE,
and L2 FTB late paths, so same-event versus next-cycle predictor assumptions
are visible in every checked sweep:

| Config | Weighted MPKI | Δ vs baseline | bpu_pkg.sv change |
| --- | --- | --- | --- |
| `baseline` | 55.2122 | — | promoted SC, ITTAGE, loop, H2P, and L2 steering geometry |
| `h2p_default` | 55.2122 | +0.0000 | explicit baseline H2P geometry cross-check |
| `l2_ftb_big` | 55.2122 | +0.0000 | 16K-entry L2 FTB study candidate |
| `combo_algo_geo_dual_fetch` | 55.2122 | +0.0000 | combined algorithm/geometry/two-ahead study candidate |
| `sc_bias_default` | 55.2416 | +0.0294 | enable SC PC-bias bank |
| `tage6_tables` | 55.3010 | +0.0889 | six tagged TAGE tables |
| `h2p_meta_t1` | 55.3619 | +0.1498 | enable per-PC H2P meta chooser |
| `h2p_off` | 56.5632 | +1.3510 | disable H2P |

**Decision: keep the promoted `ITTAGE_TARGET_HISTORY_SHIFT=8`, production-reach
ITTAGE histories, 1024-row H2P geometry, and SC-wide/threshold-6 geometry as the current RTL baseline.** The
historical tuning deltas are no longer cited as target-met evidence here because
the checked sweep artifact is capped and the RTL workload replay is prefix-only.
The current capped sweep also found H2P-threshold candidates that improve the
weighted objective, but they still regress GPU/control stressors such as
`synthetic:gpu_nested_reconvergence`, `gpu_warp_divergence`, and
`gpu_command_processor`; they remain sweep candidates rather than defaults.
The post-associativity 50K capped sweep promoted `ITTAGE_TAG_W=11` plus
`ITTAGE_PATH_HISTORY_BITS=64`/`ITTAGE_PATH_HISTORY_TOKEN_BITS=8`: the combined
candidate improved weighted MPKI from `18.9488` to `18.7346` with no per-trace
regressions across the real, CBP-5, synthetic, and GPU-weighted mix.
The expanded 50k capped sweep promoted larger ITTAGE capacity from 4K to 8K
entries and keeps seven TAGE tables as the highest-ranked remaining study
candidate. Seven TAGE tables improved the capped weighted score, but it regresses
GPU/control overfitting detectors such as `gpu_warp_divergence`,
`control_indirect_pair`, and `work_stealing_queues`, so it remains a study
knob rather than the general default.

The timing ablations show that same-event sidecar availability is load-bearing
for the current baseline: deferring SC/H2P/local-direction overrides regresses
weighted MPKI by `+1.7766`, deferring ITTAGE targets regresses by `+3.1345`,
and deferring both regresses by `+4.9111`. These are behavioural timing
knobs, not proof of physical timing closure; a future staged RTL predictor
pipeline must preserve equivalent effective latency or re-run these ablations
against the actual stage cut.

The behavioural model now implements the statistical corrector (`sc.sv`) and
the ITTAGE target-history token parameters it sweeps, so the planning model is
a faithful TAGE-SC-L companion to the RTL for these knobs. Adaptive-SC-threshold
is available in the model as a tuning lever (`SC_ADAPTIVE`) and measured
neutral on this trace set; the RTL also implements bounded adaptive threshold
control.

SC local history stays enabled after a full-trace baseline-vs-disabled check.
The promoted SC geometry is six 1024-entry tables with histories
`{0,4,10,16,27,44}` and `SC_THRESH_INIT=6`. Local history advances on every
resolved conditional so the corrector's per-PC stream remains current even when
the TAGE provider was high confidence; SC counter and threshold training remain
low-confidence gated. The geometry is still visible in the sweep for future
general-workload retuning.

A separate short local direction corrector exists as package-visible
`LOCAL_DIR_*` RTL and model geometry, with a `LOCAL_DIR_META_*` per-PC chooser.
The chooser trains signed counters when saturated local direction disagrees
with base TAGE and only allows the sidecar after it earns trust. With the H2P
sidecar enabled, disabling local-direction meta regresses the corrected capped
sweep from `36.7571` to `37.3359` weighted MPKI, including
`synthetic:gpu_nested_reconvergence +4.4271`.

An H2P/perceptron-style direction sidecar is implemented in RTL and model as
`h2p_corrector.sv` plus `H2P_*` geometry. It is threshold-gated behind TAGE/SC:
the dot-product may override only when its signed margin reaches
`H2P_THRESHOLD`, and weights train on wrong or low-margin predictions. The
behavioral evidence model mirrors the RTL bias-plus-feature vector: one
PC-indexed signed bias plus one signed weight per global/target/path history
feature bit, with saturating +/-1 training.
Target-history and path-history feature slices are implemented as
`H2P_TARGET_HIST_LEN`/`H2P_PATH_HIST_LEN`, but remain zero in the production
default: the expanded sweep found the multi-perspective variants regressed GPU
reconvergence/control traces. The latest expanded stratified sweep keeps the
1024-row, 48-history base H2P geometry: disabling H2P regresses the broader
mix by `+1.3510` weighted MPKI, while the `h2p_meta_t1` chooser is `+0.1498`
worse. An RTL/model `H2P_META_*` chooser can gate H2P until it earns per-PC
trust, and `H2P_LOWCONF_ONLY` can restrict the sidecar to weak TAGE providers,
but both remain default-off because the checked stratified sweep regressed the
broader mix.

IMLI-style loop-iteration history is also implemented as package-visible
`LOOP_IMLI_*` RTL/model geometry. The best current capped candidate,
`loop_imli_hist4_token3`, improves weighted MPKI from `36.7571` to `36.7510`,
but it regresses `synthetic:gpu_nested_reconvergence` by `+1.3021` MPKI. The
production default therefore keeps IMLI disabled while preserving the sweep
knobs for future GPU-neutral variants.

The static alternate-provider TAGE path (`TAGE_USE_ALT_ON_NA`) remains disabled:
on the expanded full-trace set it regressed weighted MPKI by 0.8440, mainly on
alias-thrash, GPU divergence, and interpreter-dispatch synthetics. The adaptive
use-alt-on-NA chooser is now implemented in RTL and model, snapshots
provider/alternate direction through the FTQ, and is enabled as the default
with `TAGE_ALT_ON_NA_ENTRIES=1024`. In the expanded 50K-branch-cap sweep,
disabling that chooser regressed weighted MPKI from `18.9779` to `19.1681`;
the old static global alternate-provider path regressed to `20.0834`.
The current full-trace sweep keeps the adaptive chooser in baseline and ranks
the promoted baseline first at `16.4290` weighted MPKI.

## Cross-domain contracts

Two interfaces leave the BPU domain.

### PMU → Zihpm

The BPU emits one strobe per cycle into `pmu_strb[PMU_EVENTS-1:0]`. The OoO
domain consumes it through `rtl/cpu/csr/bpu_to_zihpm_remap.sv`, which lands
each strobe into its Zihpm-event-bus slot through explicit name-based wiring.
The current IDs are equivalent to `bpu_pkg::bpu_pmu_to_hpm(pmu_id) = pmu_id + 1`
except for the documented FTB/BTB and meta-training naming aliases.

| BPU side | OoO side |
| --- | --- |
| `rtl/cpu/bpu/bpu_pkg.sv` (`pmu_event_e`, `bpu_pmu_to_hpm()`) | `rtl/cpu/csr/zihpm.sv` (`hpm_event_e`) |
| 27-bit `pmu_strb` from `bpu_top.pmu_strb` | 256-bit zihpm event bus driven by `bpu_to_zihpm_remap` |
| Counter readout: `csr_addr` 0..26 → 64-bit counter | OS-visible Zihpm CSRs `mhpmcounter3..15` |

Coordination evidence is produced by
`scripts/check_pmu_event_alignment.py` (writes
`docs/evidence/cpu_ap/pmu-event-alignment.json`).

### FTQ → L1I

The BPU writes predicted fetch blocks into the FTQ and emits a downstream
prefetch request via `rtl/cpu/bpu/ftq_to_l1i_shim.sv`. The cache domain
consumes `e1_ftq_to_l1i_pkg::ftq_prefetch_req_t` (40-bit physical line +
3-bit confidence + branch-target hint) on a single-cycle valid/ready
handshake with a separate flush strobe for misprediction recovery. The same
package also defines `ftq_prefetch_bundle_t`, a two-lane request bundle used by
widened consumers that can accept both predicted non-contiguous fragments in
one cycle.

The shim performs three translations:

1. Each valid `fetch_segments[]` target, falling back to scalar
   `target_pc` when no segment is valid, maps from 39-bit Sv39 virtual PC to
   a 40-bit physical line address (assumes identity V→P at this stage; real
   translation lives on the cache side).
2. `br_kind_e` → 3-bit confidence (`BR_NONE=0`, `BR_COND=4`, `BR_CALL=5`,
   `BR_RET=6`).
3. `branch_target` = `fetch_entry.taken`.

The cluster top (`rtl/cpu/cluster/e1_cluster_top.sv`) wires the shim between
`bpu_top.fetch_entry` and the cache domain. The shim is clocked and exposes
both interfaces: existing scalar consumers see the first pending segment and
drain later segments in order through an eight-entry ordered FIFO, while
widened consumers can use the bundle valid/ready lanes to accept multiple
non-contiguous segment requests together. The FIFO absorbs younger FTQ pops
while an older FDIP/L1I prefetch is backpressured; flush still drops every
queued request from the stale prediction stream.

`bpu_top` also exposes explicit vector redirect lanes:
`pred_redirect_valid[]`/`pred_redirect_pc[]` for prediction-time segment
redirects and `late_redirect_valid_lanes[]`/`late_redirect_pc_lanes[]`/
`late_redirect_ftq_idx_lanes[]` for delayed L2 patches. The scalar
`target_pc` and `late_redirect_valid/pc/ftq_idx` ports remain for compatibility,
but widened fetch-control integrations can now consume the same non-contiguous
segment stream directly instead of reconstructing redirects from the scalar
next-PC path.

`rtl/cache/prefetch/e1_fdip_l1i_prefetcher.sv` consumes the two-lane bundle
directly into a small ordered receiver queue and then drains requests onto the
existing scalar L1I prefetch port. This closes the BPU-to-FDIP bundle-consumer
contract without changing the L1I miss-pipe width.

`rtl/cpu/bpu/ftq_to_fetch_stream.sv` exposes the same ordered fetch-control
lanes, including target-block lane-1 sideband redirects, and
`rtl/cpu/bpu/fetch_stream_to_l1i_demand.sv` drives taken stream targets into
the L1I demand interface while preserving each lane's FTQ index, segment index,
and branch kind. The L1I accepts a hot lane 1 in parallel and can now also
accept a cold lane 1 into an ordered pending miss slot that launches on an
independent lane-1 miss/refill channel. This proves target-block lane 1 can
become real demand traffic, can be flushed before escape, and no longer needs
to serialize through the scalar IFU/prefetch fill pipe. The downstream
`rtl/cache/l1i/e1_l1i_dual_miss_to_l2.sv` bridge then arbitrates scalar and
lane-1 L1I misses onto the production L2 L1I acquire/grant channel and
demuxes returned line beats back to the originating refill lane.

`rtl/top/e1_soc_integrated.sv` exposes the widened prediction redirect vectors,
delayed late-redirect vectors, ordered `fetch_stream_*_o` fetch-control stream,
and optional `l1i_demand_*_o` / `l1i_demand_*_lane1_o` IFU-demand ports at the
SoC boundary. `fetch_stream_ready_i` and the demand bridge ready inputs
backpressure FTQ pop, so target-block lane 1 remains ordered and visible until
downstream fetch logic can accept both lanes.

## Blockers

1. **XiangShan upstream licensing** — Mulan PSL v2; resolved by adoption,
   tracked via `generators/xiangshan/eliza-kunminghu-manifest.json`
   (BPU IP pin) and `generators/chipyard/eliza-kunminghu-manifest.json`
   (whole-core selection, owned by the OoO domain).
2. **Full two-taken/non-contiguous fetch** — current geometry parameterises
   `MAX_BR_PER_BLOCK = 2`, stores both FTB slots, carries both through the
   FTQ, and emits two `fetch_segments` for the bounded same-block case where
   an earlier conditional falls through and a later conditional redirects.
   The BPU-to-L1I shim exposes a two-lane prefetch bundle for those segments
   while preserving scalar compatibility, and `bpu_top` now exposes vector
   redirect lanes for prediction-time and delayed L2 redirect events. The
   BPU now performs a bounded second FTB read into a predicted taken target
   block and can emit lane 1 for direction-unambiguous direct/call/indirect
   target-block hits, strongly-taken conditional target-block hits, and
   conservative target-block returns. Return lookahead uses the call
   fall-through when the first branch is a call, or the current RAS top when
   the first branch does not mutate the RAS; it does not predict a return after
   a first return because the next RAS top is not available combinationally.
   `ftq_to_fetch_stream` and `fetch_stream_to_l1i_demand` now prove lane 1 can
  be consumed as ordered L1I demand traffic with redirect-flush purge
  and retained FTQ/segment/kind provenance. `e1_soc_integrated` also surfaces
  the widened redirect vectors, ordered fetch-control stream, and lane-0/lane-1
  L1I demand ports at the structural SoC boundary; the stream and demand ready
  inputs backpressure FTQ pop rather than dropping lane 1. L1I now accepts a
  cold lane-1 demand into an ordered pending miss slot and services it through
  an independent lane-1 miss/refill channel, while `e1_l1i_dual_miss_to_l2`
  connects those scalar/lane-1 miss pipes to the production L2 L1I acquire
  channel. Remaining work is full SoC-level instantiation of the production
  fetch/cache hierarchy behind `e1_soc_integrated` once the production
  core/cache top is selected, not a missing lane-1 miss-to-L2 mechanism.
3. **Commit-time predictor replay closure** — top-level TAGE/SC/ITTAGE
   updates replay FTQ histories, providers, and SC/TAGE confidence metadata by
   `resolve.ftq_idx`; the resolver bus no longer carries legacy provider
   mirrors. Non-FTQ directed resolve injection falls back to architectural
   history and base-provider update semantics.
4. **Speculative history recovery survivor replay** — on a redirect, current
   speculative direction and target histories restore from the resolved FTQ
   prediction-time snapshot and then apply the resolved outcome. The remaining
   precision gap is only for a future selective-redirect policy that preserves
   younger FTQ entries; those surviving predictions would need a replay walk.
5. **L1I translation boundary** — `ftq_to_l1i_shim` lands the prefetch request
   on the cache agent's interface, the FDIP/L1I ready path has cocotb
   coverage, the shim queues younger FTQ prefetches behind a blocked older
   prefetch, and FDIP can consume both bundle lanes in one cycle. Real
   iTLB-on-receive translation remains in the cache domain.
6. **Real-trace MPKI evidence** — see Accuracy targets.
7. **Verilator/Yosys/SBY hosting** — the chip package has historically relied
   on Docker/Nix shells for these tools; the local oss-cad-suite checkout
   under `external/oss-cad-suite/` resolves them. `make bpu-lint`,
   `make cocotb-bpu`, and `make formal-bpu` fail closed with `STATUS: BLOCKED`
   when the suite is missing.
8. **Bounded formal smoke for the FTQ and RAS** — FTQ bounded queue properties
   pass through the yosys-slang SystemVerilog frontend. RAS elaborates with
   FORMAL monitor ports and proves the speculative-pointer range invariant;
   cocotb covers the RAS underflow pulse, restore behavior, and full BPU
   regression (104/104 across 10 modules, including the L1I frontend path, TAGE
   allocation-pressure useful aging, SC all-resolves local-history maintenance,
   uFTB block-keying, widened L1I prefetch-bundle exposure and downstream
   FDIP bundle consumption plus duplicate/pollution suppression,
   set-associative ITTAGE collision retention, expanded ITTAGE upper-table
   storage, ITTAGE useful-zero victim replacement, optional SC bias-bank,
   H2P and multi-perspective H2P gating, local-direction gating,
   IMLI loop-history gating, return-target fallback, SRAM collision forwarding, and same-VA
   cross-context predictor isolation/flush).

## Verification surface

| Gate | Command | Output |
| --- | --- | --- |
| Parameter geometry | `make branch-prediction-check` | `docs/evidence/cpu_ap/branch-prediction-params.json` |
| Cross-domain PMU IDs | `make pmu-event-alignment-check` | `docs/evidence/cpu_ap/pmu-event-alignment.json` |
| Verilator strict lint | `make bpu-lint` | `build/reports/bpu/lint-status.yaml` |
| Cocotb regression | `make cocotb-bpu` | `build/reports/bpu/cocotb-aggregate.json` (target-module aggregate); raw XMLs live under `verify/cocotb/bpu/results/*.xml` and may include auxiliary debug/MPKI runs. |
| SymbiYosys formal | `make formal-bpu` | `build/reports/bpu/formal-status.yaml` |
| MPKI eval (RTL, cocotb) | `make mpki-eval-rtl` | `docs/evidence/cpu_ap/mpki_results_synthetic.json` |
| QEMU-RV64 workload replay (RTL, cocotb) | `make mpki-eval-rtl`, `make mpki-eval-rtl-stratified`, `make mpki-eval-rtl-full` | `docs/evidence/cpu_ap/mpki_results_workload_rtl.json` |
| MPKI eval (model only) | `make mpki-eval-model` | `benchmarks/results/branch-prediction-mpki-model.json` |
| Full MPKI evidence refresh | `make branch-prediction-refresh` | Regenerates model/RTL MPKI evidence, then runs `make branch-prediction-check` |
| E1 RTL vs CVA6 model MPKI | `make bpu-vs-cva6-mpki-rtl` | `docs/evidence/cpu_ap/bpu-vs-cva6-mpki-rtl.json` |
| MPKI vs CBP-5 table | — | `docs/evidence/cpu_ap/mpki_synthetic_vs_cbp5_reference.md` |
| Behavioural model unit tests | `make bpu-model-test` | pytest (TAGE-SC-L+ITTAGE model) |
| Real RV64 workload trace | `make bpu-workload-trace` | `external/workload-traces/<name>.btrace.json` |
| Geometry tuning sweep | `make bpu-sweep`, `make bpu-sweep-full` | `docs/evidence/cpu_ap/bpu_sweep_results.json`, `…_leaderboard.md` |
| Full proxy shard sweep | `make bpu-sweep-full-proxy-shard` | `docs/evidence/cpu_ap/bpu_sweep_full_proxy_shard.json`, `…_leaderboard.md` |
| Full IO/media shard sweep | `make bpu-sweep-full-io-media-shard` | `docs/evidence/cpu_ap/bpu_sweep_full_io_media_shard.json`, `…_leaderboard.md` |
| Full system/GPU shard sweep | `make bpu-sweep-full-system-gpu-shard` | `docs/evidence/cpu_ap/bpu_sweep_full_system_gpu_shard.json`, `…_leaderboard.md` |
| Full browser/build/crypto shard sweep | `make bpu-sweep-full-browser-build-crypto-shard` | `docs/evidence/cpu_ap/bpu_sweep_full_browser_build_crypto_shard.json`, `…_leaderboard.md` |

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
- `rtl/cpu/bpu/ftq_to_fetch_stream.sv` — observational two-lane fetch-control
  stream adapter for FTQ segments plus target-block lane-1 sideband redirects.
- `rtl/cpu/bpu/fetch_stream_to_l1i_demand.sv` — scalar IFU-demand consumer for
  ordered taken fetch-stream targets with FTQ/segment/kind provenance.
- `verify/cocotb/bpu/` — cocotb unit and integration tests
  (10 wrappers / 103 target tests).
- `verify/formal/bpu/` — SymbiYosys formal harnesses.
- `benchmarks/cpu/branch/` — MPKI harness and synthetic traces
  (35 synthetic generators).
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
