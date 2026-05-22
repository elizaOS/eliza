# Branch Predictor Production Gap Pass

Scope: behavioural benchmark/model pass plus the matching bounded RTL slice.

## Implemented bounded experiment

0. **Expanded workload repertoire**
   - Added synthetic coverage for nested/IMLI-like loop phases,
     XOR-correlated direction branches, path-correlated vtable indirects, and
     mixed interpreter dispatch. These keep future TAGE/SC/ITTAGE work from
     overfitting only to the original loop/GPU/JIT traces.
   - Added another stress pass for phase-changing server behavior,
     low-index alias thrash, GPU occupancy phase changes, and mostly-normal
     call/return streams with non-LIFO exception targets.

1. **Dual conditional branches per fetch block**
   - Gap: the prior model scored every retired branch as if it received an
     independent front-end prediction. That hides a common production issue:
     one fetch block can contain an early not-taken guard and a later taken
     redirect.
   - Model change: `FETCH_BLOCK_BRANCH_SLOTS` limits conditional prediction
     bandwidth within a `FETCH_BLOCK_BYTES` block. The default is now `2`,
     matching the RTL FTB/FTQ slot geometry; the tests keep an explicit
     one-slot baseline to quantify the old gap.
   - RTL change: FTB entries now store two branch slots by fetch block, FTQ
     entries carry that metadata, TAGE/SC/loop lookup uses the first branch
     slot PC, and a second-slot bimodal slice redirects to a later conditional
     when the earlier conditional falls through.
   - Test trace: `synthetic_dual_branch_fetch_block` creates two conditionals
     in one 32-byte block. One-slot mode records `fetch_slot_blocked` and
     `fetch_slot_misp`; two-slot mode removes those slot misses.
   - Sweep knobs: `fetch_block_dual_branch` and
     `combo_algo_geo_dual_fetch`.

2. **FTQ prediction-time snapshots**
   - Gap: FTQ previously carried provider IDs and RAS top but not the full
     prediction-time state needed for production commit/recovery replay.
   - RTL change: `ftq_entry_t` now preserves global history, mixed ITTAGE
     history, target/path-history components, RAS speculative pointer plus
     top-entry restore contents, TAGE provider counter, TAGE low-confidence,
     and SC override decision bits.
   - Test: `ftq_preserves_prediction_snapshots` round-trips the new fields.

2a. **RAS stack-content restore after wrong-path returns**
   - Gap: RAS redirect recovery restored only the speculative pointer. A
     wrong-path speculative return can invalidate the top entry, so restoring
     the pointer alone leaves the next return with an invalid RAS top.
   - RTL change: FTQ/resolve metadata now carries the prediction-time RAS top
     entry valid bit and address. On redirect, RAS restores both the
     speculative pointer and the checkpointed top entry.
   - Tests: `ras_restore_reinstates_popped_top_entry` proves the standalone
     RAS restores content after a speculative pop;
     `bpu_mispredict_restores_ras_entry_after_wrong_path_return` proves the
     top-level BPU predicts the restored return after a wrong-path return pop.

3. **uFTB branch kind, target confidence, and RAS action parity**
   - Gap: the zero-bubble uFTB path was target-only, so a uFTB-only hit could
     not classify calls, returns, or indirects and could not carry target
     stability metadata.
   - RTL change: uFTB entries now store `next_pc`, `br_kind_e`, call
     fall-through PC, and a small target confidence counter. Matching updates
     saturate confidence; changed target/kind updates keep the entry but reset
     confidence to weak.
   - Top-level change: a uFTB-only hit now exports the stored branch kind.
     Confident uFTB-only calls push the mirrored fall-through PC into the
     speculative RAS, and confident uFTB-only returns pop/use the RAS top when
     available instead of always using the stored target. Top-level uFTB-only
     steering is confidence-gated by `UFTB_STEER_CONF_MIN`, so one weak
     allocation cannot redirect fetch until the target/kind pair repeats.
   - Tests: `uftb_train_and_hit` checks kind/confidence on the fast path;
     `uftb_updates_kind_and_confidence` covers confidence growth and reset on
     target/kind changes; `bpu_confident_uftb_only_call_return_uses_ras`
     evicts the FTB entries while retaining confident uFTB entries and proves
     uFTB-only call/return RAS behavior.

4. **FTB age-based replacement**
   - Gap: FTB set replacement was a per-set round-robin pointer, so a hot
     block could be evicted by allocation churn even after a fresh hit.
   - RTL change: FTB replacement is now invalid-first and age-based. Lookup
     hits and update hits make the matching way most-recent; other valid ways
     age with saturation; allocation picks invalid ways before the oldest valid
     way.
   - Test: `ftb_replacement_preserves_recently_used_way` fills one hashed set,
     refreshes a hot way, allocates another colliding block, and proves the
     hot way survives while the oldest way is evicted.

5. **uFTB age-based replacement**
   - Gap: uFTB set replacement was still round-robin, so a hot zero-bubble
     target could be evicted by same-set churn even after a recent hit.
   - RTL change: uFTB replacement is now invalid-first and age-based. Lookup
     hits and update hits make the matching way most-recent; allocation picks
     invalid ways before the oldest valid way.
   - Test: `uftb_replacement_preserves_recently_used_way` fills a colliding
     uFTB set, refreshes the hot way, allocates another colliding target, and
     proves the hot way survives while the oldest stale way is evicted.

## Existing coverage found

6. **TAGE allocation/update policy variants**
   - Already modelled: allocation decrement, periodic useful-bit aging,
     longer history schedules, more tables, larger tables, and a bounded
     USE_ALT_ON_NA alternate-provider mode.
   - RTL already ages occupied candidate victims during allocation pressure
     and exposes periodic useful-bit reset through the CSR/useful-reset path.
     RTL/model now also implement `TAGE_USE_ALT_ON_NA`.
   - Remaining question is evidence, not implementation: keep full-trace
     validation in the sweep harness so future geometry changes do not lose
     the allocation-starvation fix.
   - Default decision: keep alternate-provider mode disabled for now. The
     expanded full-trace sweep regressed weighted MPKI from `10.9421` to
     `11.7862`, led by `synthetic:alias_thrash`,
     `synthetic:gpu_warp_divergence`, and
     `synthetic:interpreter_dispatch_mixed`.

7. **SC/local-history variants**
   - Already modelled: static threshold, adaptive threshold, wider SC tables,
     more SC history lengths.
   - Implemented local-history folding into the SC index in both model and
     RTL. `SC_LOCAL_HISTORY_BITS=8` is now default after a full-trace
     baseline-vs-disabled check with the promoted target-history shift improved
     weighted MPKI from `5.5359` to `5.5196`.
   - RTL also implements bounded adaptive threshold control; it remains a
     tuning/evidence question rather than a missing mechanism.
   - Residual risk: the win is concentrated in GPU/divergence and
     dual-branch-block traces; keep this knob visible for future
     general-workload retuning.

8. **Loop predictor details**
   - Already modelled: backward-only training, confidence saturation, stale
     trip-count confidence drop, capacity knob.
   - Tests now make stable-trip convergence load-bearing at the standalone
     loop predictor and top-level BPU arbitration.
   - Implemented invalid-first, then weak/old-first replacement in RTL so
     one-shot loop allocation churn does not evict saturated hot loop entries.
     Standalone cocotb now fills past table capacity and verifies the hot loop
     still predicts.
   - Remaining gap: no nested-loop path tagging and no early loop-exit
     confidence hysteresis study.

9. **Indirect target history / path hashing**
   - Already modelled: target-history length, token width, target shift,
     path-history length, path token width, path shift, ITTAGE replacement
     policy variants.
   - Implemented ITTAGE useful-bit replacement/aging in RTL and model: correct
     providers increment useful, mismatching providers age useful down, periodic
     aging decays stale entries, and misprediction allocation can replace
     invalid or useful-zero victims instead of only empty slots.
   - Implemented target-history token width/shift as first-class RTL package
     parameters. The full-trace validation run promoted
     `ITTAGE_TARGET_HISTORY_SHIFT=8` after improving weighted MPKI from
     `5.6018` to `5.5196`.
   - Promoted longer ITTAGE target histories `(4, 10, 20, 40, 80)` after a
     full-trace check improved weighted MPKI from `5.5196` to `5.4693` with no
     reported regressions. On the expanded workload set, the old schedule is
     `11.0751` versus current baseline `10.9421`.
   - RTL support added for path-history mixing with
     `ITTAGE_PATH_HISTORY_BITS`, `ITTAGE_PATH_HISTORY_TOKEN_BITS`, and
     `ITTAGE_PATH_HISTORY_SHIFT`.
   - Default remains disabled: the 50K capped sweep regressed weighted MPKI
     (`baseline=9.4056`, path variants `9.4070`-`9.4123`) and specifically
     hurt `synthetic:gpu_command_processor`.
   - Top-level RTL now has a cocotb check that weak stale ITTAGE targets yield
     to stable high-confidence FTB targets.

## Ranked remaining RTL-facing gaps

1. **Full two-taken/non-contiguous fetch**: the bounded same-block conditional
   case is now implemented, but the fetch contract still emits one next-PC and
   does not fetch discontiguous fragments after two taken redirects.
2. **Commit-time predictor replay from FTQ**: FTQ now preserves rich
   prediction-time snapshots, but update still receives provider IDs through
   `bpu_resolve_t`; a later backend-facing change should replay updates from
   the FTQ entry itself.
3. **Speculative history recovery precision**: FTQ snapshots exist, but
   misprediction recovery still rebuilds speculative histories from
   architectural state plus the resolved outcome rather than restoring the
   prediction-time snapshot and replaying younger survivors.
4. **Full-trace validation of TAGE allocation decrement plus u-bit aging**:
   likely useful, but needs long trace evidence because short traces understate
   allocation starvation.
5. **ITTAGE path-history enablement**: RTL/model support exists, but default
   enablement is blocked by current capped-sweep regressions; revisit with
   real JS/JIT or interpreter traces.
6. **Local-history SC/bias corrector**: local-history SC is implemented and
   enabled. Alternate-provider TAGE is implemented but disabled by evidence.
   A separate bias-bank family remains optional and should be added only if
   full traces show persistent per-PC bias misses.
7. **Loop predictor detail work**: replacement now preserves confident hot
   loops under table churn; nested-loop path tagging and exit hysteresis remain
   lower priority until real workloads show loop-table aliasing or phase misses.
