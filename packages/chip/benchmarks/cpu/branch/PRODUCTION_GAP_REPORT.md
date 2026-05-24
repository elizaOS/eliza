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
   - Added command-buffer validation, work-stealing queue scheduling,
     hash-probe/inline-cache, and allocator/GC-barrier synthetics as
     overfitting detectors for GPU drivers, runtimes, and control-plane code.
   - Added Android ART/Hermes inline-cache tiering, OS signal/exception
     non-LIFO unwind, and GPU driver submit-phase synthetics to keep the
     workload set bounded while covering mobile runtime dispatch, kernel/user
     exception stress, and ioctl/queue/fence phase behavior.
   - Added `workload_class_phase_alias`, where the same virtual branch PCs are
     reused by general and GPU runtime phases with different behavior. This
     makes the new workload-class context hook measurable in the Python sweep
     instead of only in RTL cocotb.
   - Added `cross_asid_same_pc_alias` and
     `wasm_threaded_interpreter_tiering` to cover hostile same-VA predictor
     aliasing across ASID/VMID/privilege domains and Wasm/threaded interpreter
     tier-up/deopt dispatch phases.

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
     when the earlier conditional falls through. The top-level FTQ contract now
     emits two `fetch_segments` for that bounded same-block fall-through plus
     later-taken case.
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
   - Production follow-up: uFTB is now fetch-block-keyed like the FTB, so a
     resolved branch at a nonzero block offset trains the entry that the
     block-PC lookup will use. `uftb_nonzero_offset_branch_hits_block_lookup`
     covers the formerly-missed case.

4. **FTB age-based replacement**
   - Gap: FTB set replacement was a per-set round-robin pointer, so a hot
     block could be evicted by allocation churn even after a fresh hit.
   - RTL change: FTB replacement is now invalid-first and age-based. Lookup
     hits and update hits make the matching way most-recent; other valid ways
     in the touched set age with saturation; allocation picks invalid ways
     before the oldest valid way. The age maintenance is touched-set only, not
     a global all-set sweep, so the policy maps to production SRAM power/timing
     expectations.
   - Test: `ftb_replacement_preserves_recently_used_way` fills one hashed set,
     refreshes a hot way, allocates another colliding block, and proves the
     hot way survives while the oldest way is evicted.

5. **uFTB age-based replacement**
   - Gap: uFTB set replacement was still round-robin, so a hot zero-bubble
     target could be evicted by same-set churn even after a recent hit.
   - RTL change: uFTB replacement is now invalid-first and age-based. Lookup
     hits and update hits make the matching way most-recent; other valid ways
     age only in the touched set; allocation picks invalid ways before the
     oldest valid way.
   - Test: `uftb_replacement_preserves_recently_used_way` fills a colliding
     uFTB set, refreshes the hot way, allocates another colliding target, and
     proves the hot way survives while the oldest stale way is evicted.

5a. **Predictor context isolation and flush**
   - Gap: the BPU lookup and update path was PC-only. Identical virtual PCs
     from different ASIDs/VMIDs/security domains could share target entries
     and direction state, which is not acceptable for process switches,
     virtualization, or user/kernel driver transitions.
   - RTL change: `bpu_context_t` now carries ASID, VMID, privilege,
     secure-domain, and workload-class bits on lookup and resolve. The class
     field is a software/runtime-visible phase hook for broad policies such as
     general CPU, GPU driver/launch, and ML runtime control. FTQ entries and
     lookup results retain the context for replay/debug; replay is
     context-checked before predictor updates use FTQ metadata. FTB/uFTB/L2
     FTB entries store and compare the context and fold a compact context hash
     into index/tag generation. `bpu_top` also feeds a context-mixed PC into
     TAGE, SC, bimodal, loop, and ITTAGE lookups/updates so direction and
     local-history state do not alias only by virtual PC.
   - Flush change: `bpu_flush_t` provides an explicit predictor invalidation
     request. A flush blocks same-cycle updates, invalidates target arrays,
     clears FTQ, pending L2 requests, speculative/architectural histories, and
     RAS state; context-qualified target-array invalidation is supported at
     the FTB/uFTB module boundary.
   - Test: `bpu_context_isolates_target_predictions_and_flushes` trains the
     same virtual PC under two ASIDs with different targets, proves neither
     context consumes the other's target entry, and proves a global predictor
     flush clears both trained target paths.
     `bpu_workload_class_isolates_target_predictions_and_flushes` repeats the
     same isolation test for two workload classes under the same ASID/VMID and
     proves a context-qualified flush can invalidate one class while preserving
     the other.
   - Model parity: `BranchEvent.workload_class` now folds into the model's
     predictor PC key for target arrays and direction/target sidecars.
     `test_workload_class_partitions_model_target_predictions` proves the same
     PC can retain separate general and GPU-phase targets.

5b. **Target-array parity poison protection**
   - Gap: production predictor SRAMs need at least lightweight data-integrity
     protection. A corrupted uFTB/FTB/L2 FTB entry should be treated as a miss
     and retrained, not used to steer fetch to a bogus target.
   - RTL change: uFTB and FTB entries now store one parity bit over the context,
     tag, target payload, branch kind, confidence, and slot metadata. Lookup
     accepts only parity-clean entries; a matching corrupted entry is
     invalidated locally. The same FTB module instance also covers the delayed
     L2 FTB tier.
   - Test: `uftb_parity_error_invalidates_entry` and
     `ftb_parity_error_invalidates_entry` inject a packed-entry parity fault
     and prove the lookup misses instead of redirecting.

5c. **Defined FTB/uFTB read-during-write collision semantics**
   - Gap: production BTB/FTB SRAM macros differ on same-cycle read/write
     behavior. Depending on the macro's undefined collision mode can expose
     stale targets, miss a just-resolved branch, or make simulation differ
     from silicon.
   - RTL change: FTB and uFTB lookup now write-forward same-cycle resolver
     updates for both cold allocation and matching-entry overwrite. FTB also
     forwards same-cycle L2 refill data when there is no resolver update, and
     resolver update wins over refill. Predictor flush suppresses lookup-visible
     hits in the same cycle.
   - Tests: `ftb_same_cycle_lookup_update_forwards_write` and
     `uftb_same_cycle_lookup_update_forwards_write` cover cold allocation and
     existing-entry overwrite forwarding.

5d. **Return-target fallback for non-LIFO returns**
   - Gap: RAS repair handles ordinary call/return speculation, but production
     code also has non-LIFO returns from exceptions, fibers/coroutines,
     language runtimes, and stack manipulation. A live RAS can be empty or
     confidently wrong for those streams.
   - RTL change: `bpu_top` now trains a small context-qualified return-target
     fallback table on resolved returns. On predicted returns, the table fills
     the target when the RAS is empty and can override a saturated conflicting
     live RAS top for the same return PC/context. The storage is separate from
     ITTAGE so return recovery does not pollute indirect-target prediction.
   - Tests: `bpu_return_fallback_predicts_when_ras_empty` and
     `bpu_return_fallback_overrides_confident_ras_mismatch` cover the empty-RAS
     and confident-mismatch paths.

5e. **Explicit SC bias bank**
   - Gap: the SC folded local history into its signed tables, but production
     correctors commonly carry a cheap per-PC bias component so persistent
     taken/not-taken tendency does not consume all of the history-indexed
     tables.
   - RTL/model change: SC now has a 2048-entry, 5-bit signed per-PC bias bank
     that can be added to the summed corrector vote. When enabled, the bank
     trains on every resolved conditional, including high-confidence TAGE
     updates, while SC still only overrides low-confidence TAGE when the summed
     vote clears threshold.
   - Default decision: keep the bias bank disabled. The expanded 50K capped
     sweep ranks the disabled default at weighted MPKI `36.7571`; enabling the
     2048-entry default scores `37.1978`, with regressions concentrated in
     GPU wavefront/divergence, interpreter dispatch, and alias-pressure traces.
   - Sweep knobs: `sc_bias_default` and `sc_bias_big` let the workload harness
     continue checking whether this production feature becomes useful as
     workloads or geometry change.
   - Tests: `sc_bias_bank_is_disabled_by_default`,
     `test_sc_bias_bank_trains_on_high_confidence_updates`, and
     `test_sc_bias_bank_disabled_by_default_after_sweep` cover the RTL default
     and model enable/disable paths.

5f. **Local direction corrector model parity and default policy**
   - Gap: `bpu_top` already had a small per-PC local-history direction
     corrector, but it was hard-coded inside the top level and absent from the
     MPKI model. That made the sweep optimistic: it could not account for a
     production RTL override that runs after SC and before TAGE.
   - RTL/model change: the corrector geometry is now package-visible through
     `LOCAL_DIR_*` parameters, and the Python model includes the same 1024-entry
     2-bit-history/2-bit-counter structure and priority. The harness can sweep
     `local_dir_on`, `local_dir_off`, `local_dir_big`, `local_dir_meta_off`,
     and learned `local_dir_meta*` variants.
   - RTL/model change: `LOCAL_DIR_META_*` is wired in RTL and model. It trains
     a small signed per-PC counter when the saturated
     local predictor disagrees with the base TAGE result, and only allows the
     local override after the sidecar has earned trust for that branch stream.
   - Default decision: enable the local direction corrector and meta chooser
     for the current production default. With H2P enabled, disabling local meta
     regresses weighted MPKI from `36.7571` to `37.3359`, including
     `synthetic:gpu_nested_reconvergence +4.4271`.
   - Tests: `bpu_local_direction_corrector_enabled_by_default`,
     `test_local_direction_corrector_learns_short_alternation`,
     `test_local_direction_corrector_overrides_tage_when_saturated`, and
     `test_local_direction_corrector_enabled_with_meta_after_h2p_sweep` cover the
     RTL default and model enable/disable paths.

5g. **H2P/perceptron-style direction sidecar**
   - Gap: production TAGE-SC-L derivatives increasingly include neural or H2P
     sidecars for branches whose direction is better explained by a weighted
     global-history dot product than by tagged-table matching alone.
   - RTL/model change: `h2p_corrector.sv` implements a PC-indexed signed
     weight table with `H2P_*` package geometry. It computes a bias plus one
     signed weight per global-history feature bit, threshold-gates overrides
     behind TAGE/SC, and trains on wrong or low-margin resolved conditionals.
     The Python evidence model now mirrors that bias-plus-feature vector
     instead of using a single scalar per whole history tuple. It also has
     sweepable target-history and path-history feature slices
     (`H2P_TARGET_HIST_LEN`, `H2P_PATH_HIST_LEN`) so the same block can act as
     a compact multi-perspective corrector when evidence justifies it. The
     model exposes the same `h2p_*` sweep knobs.
   - Default decision: enable H2P with 1024 rows, 48 global-history features,
     and threshold 36. The latest expanded stratified sweep baseline is
     `55.2122` weighted MPKI over the twenty-trace QEMU workload set plus
     synthetic hard shapes and CBP-5 samples; `h2p_off` is `+1.3510` worse.
     Multi-perspective H2P, H2P meta, and low-confidence-only H2P are
     implemented and sweepable, but remain default-off because the current
     checked variants regress the broader GPU/control and runtime mix.
   - Tests: `test_h2p_corrector_can_override_base_direction_when_confident`,
     `test_h2p_model_uses_rtl_bias_plus_feature_weights`,
     `test_h2p_multi_perspective_target_history_can_split_same_pc`,
     `test_h2p_lowconf_only_blocks_high_confidence_base_override`, and
     `test_h2p_corrector_enabled_by_default_after_sweep` cover the model.
     A post-promotion stratified 1000-branch smoke sweep keeps baseline ahead
     of `h2p_meta_t1` (`55.2122` versus `55.3619` weighted MPKI), so
     meta-gated H2P remains a study candidate rather than production default.
     An RTL/model `H2P_META_*` chooser is also implemented and sweepable; it
     blocks H2P overrides until the sidecar has beaten base direction for that
     PC. After adding `btb_confidence_churn` and the broader QEMU-RV64
     workload proxies to the sweep set, H2P meta remains default-off in
     production geometry because its weighted result is not GPU/control
     neutral. The RTL
     chooser update path now uses explicitly typed +/-1 increments so optional
     chooser counters do not trip over signed one-bit literal semantics. `make
     bpu-lint` covers the H2P corrector and default-off chooser integration in
     the strict BPU lint set; top-level cocotb covers the default package path.

5h. **IMLI-style loop-iteration history**
   - Gap: the loop predictor had path signatures, but they were intentionally
     stable across ordinary loop iterations and did not encode previous loop
     trip counts. Production TAGE-SC-L families commonly use IMLI-style
     iteration history so nested loops with phase-dependent trip counts can be
     separated without poisoning the ordinary loop predictor.
   - RTL/model change: `LOOP_IMLI_*` package parameters now describe a small
     loop-exit iteration-history signature. `loop_predictor.sv` can fold the
     history into its path signature and push a compact token containing the
     loop PC and observed exit iteration count. The Python model implements the
     same mechanism and the sweep exposes `loop_imli_*` variants.
   - Default decision: keep IMLI disabled for the current production default.
     The best capped candidate, `loop_imli_hist4_token3`, improves weighted
     MPKI from `36.7571` to `36.7510`, but regresses
     `synthetic:gpu_nested_reconvergence` by `+1.3021` MPKI. Because the
     objective explicitly favors GPU workloads when possible, the feature stays
     implemented/sweepable but default-off until a GPU-neutral variant wins.
   - Tests: `test_loop_predictor_imli_signature_separates_repeating_trip_phases`
     and `test_loop_predictor_imli_can_be_disabled_for_ablation` cover the
     model. `make cocotb-bpu-loop` proves the default-off RTL preserves stable
     loop convergence, tag/path separation, replacement, and early-exit
     hysteresis.

5i. **First-class direct unconditional branch kind**
   - Gap: direct unconditional jumps were previously collapsed into
     `BR_COND`, which made trace ingest and RTL accounting treat always-taken
     target-array branches as conditional-direction traffic.
   - RTL/model change: `br_kind_e` now includes `BR_DIRECT`. FTB/uFTB/L2 target
     state can carry direct jumps; `bpu_top` predicts them taken from target
     arrays without using TAGE/SC/H2P/local direction, ITTAGE, or RAS. CBP-5
     `UNCOND_DIR_BR` and RV64 `j`/`jal x0` decode to `BR_DIRECT` in the model
     harness.
   - Tests: `test_direct_branch_uses_target_array_without_direction_or_ittage_training`
     covers the model, `test_execlog_decoder_reconstructs_branch_classes`
     checks RV64 decode, and
     `bpu_direct_branch_uses_target_without_direction_or_ittage_counters`
     proves top-level RTL steers to the direct target without incrementing
     conditional, indirect, call, or return PMU counters.

## Existing coverage found

6. **TAGE allocation/update policy variants**
   - Already modelled: allocation decrement, periodic useful-bit aging,
     longer history schedules, more tables, larger tables, and a bounded
     USE_ALT_ON_NA alternate-provider mode.
   - RTL already ages occupied candidate victims during allocation pressure
     and exposes periodic useful-bit reset through the CSR/useful-reset path.
     RTL/model now also implement the adaptive use-alt-on-NA chooser.
   - Remaining question is evidence, not implementation: keep full-trace
     validation in the sweep harness so future geometry changes do not lose
     the allocation-starvation fix.
   - Default decision: keep static alternate-provider mode disabled. The
     expanded 50K capped sweep regressed weighted MPKI from `18.9779` to
     `20.0834`, led by alias, GPU/control, and interpreter stressors.
   - Implemented adaptive use-alt-on-NA in RTL and model: the risky
     alternate-provider path is behind a per-PC/provider chooser instead of the
     static global enable. The focused synthetic pass improved baseline MPKI
     from `27.3780` to `27.2004` while the old static mode regressed to
     `29.5707`.
     The expanded 50K capped sweep over local real traces, expanded synthetics,
     and CBP5 samples shows the chooser is load-bearing: disabling it regressed
     weighted MPKI to `19.1681` (`+0.1901`).

7. **SC/local-history variants**
   - Already modelled: static threshold, adaptive threshold, wider SC tables,
     more SC history lengths.
   - Implemented local-history folding into the SC index in both model and
     RTL. `SC_LOCAL_HISTORY_BITS=8` is now default after a full-trace
     baseline-vs-disabled check with the promoted target-history shift improved
     weighted MPKI from `5.5359` to `5.5196`.
   - Production follow-up: SC local history now advances on every resolved
     conditional, including high-confidence TAGE predictions. Counter and
     threshold training remain low-confidence gated, but the local-history
     stream no longer goes stale before a later low-confidence lookup.
     Standalone cocotb and model tests cover the all-resolves update path.
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
   - Implemented 8-bit path signatures keyed from stable target context, not
     raw direction history, so same-PC loop entries can separate call/indirect
     contexts without changing signature on each loop iteration.
   - Implemented single-early-exit hysteresis: one short trip lowers confidence
     and marks the entry but keeps the saturated bound; a normal trip recovers
     confidence, while repeated short exits rewrite the bound.
   - Tests: standalone loop predictor and Python model cover same-PC path
     separation plus one-off early-exit recovery; top-level BPU still proves
     known-trip loop convergence.

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
   - Kept the longer ITTAGE target-history schedule `(4, 10, 20, 40, 80)`.
     A shorter `(4, 8, 13, 16, 32)` study result slightly improved the capped
     1K and 5K stratified sweeps, but `make branch-prediction-check` correctly
     rejected it because max indirect history 32 is below the production reach
     floor of 80.
   - Promoted larger ITTAGE capacity `(1024, 1024, 2048, 2048, 2048)` after
     the expanded 50K capped sweep improved weighted MPKI from `19.0904`
     (`ittage_pre_big`) to the then-current `18.9779` baseline. The later
     full-trace finalist sweep with loop/L2 changes ranks the current baseline
     first at `16.4290` weighted MPKI.
   - Implemented 2-way set-associative ITTAGE storage in RTL and the Python
     model using the same total entry counts. This closes the direct-mapped
     alias gap where two hot indirect sites with different tags but the same
     folded index evicted each other; standalone cocotb and model tests now
     prove both colliding targets remain hittable.
   - RTL support added for path-history mixing with
     `ITTAGE_PATH_HISTORY_BITS`, `ITTAGE_PATH_HISTORY_TOKEN_BITS`, and
     `ITTAGE_PATH_HISTORY_SHIFT`.
   - Promoted `ITTAGE_TARGET_HISTORY_TOKEN_BITS=5` after the expanded capped
     objective improved weighted MPKI from `22.2137` to `21.7385` versus the
     previous 7-bit token. The reported regressions were outside the GPU
     workloads, so this is a better production default for the current
     GPU-weighted mix.
   - Promoted `ITTAGE_TAG_W=11` plus
     `ITTAGE_PATH_HISTORY_BITS=64`/`ITTAGE_PATH_HISTORY_TOKEN_BITS=8` after the
     post-associativity 50K exhaustive sweep improved weighted MPKI from
     `18.9488` to `18.7346` with no per-trace regressions. This retires the
     prior path-history blocker for the current workload mix.
   - Top-level RTL now has a cocotb check that weak stale ITTAGE targets yield
     to stable high-confidence FTB targets.
   - Model/sweep evidence now reports ITTAGE hit, target-used, weak-yield,
     update, allocation, weak-target replacement, victim replacement,
     provider-eviction, and useful-aging counters. The branch-prediction gate
     requires those counters in `bpu_sweep_results.json`, so indirect-target
     chooser/replacement behavior is visible in every checked geometry sweep
     without expanding the locked Zihpm architectural PMU enum.
   - Standalone RTL ITTAGE now proves the expanded upper-table capacity by
     allocating and hitting a table-4 index above 1023.
   - Standalone RTL ITTAGE now proves useful-zero occupied victim replacement,
     matching the model's invalid-first then useful-zero allocation policy under
     indirect-target alias pressure.
   - Standalone RTL TAGE now proves allocation-pressure useful-bit decrement
     and alternating useful-reset bit aging, covering the allocation-starvation
     escape hatch.

9a. **Predictor timing/late-override evidence**
   - Gap: the behavioural model previously assumed SC, H2P, local-direction,
     and ITTAGE target sidecars were all available in the same prediction
     event. That is the desired production contract, but it hid the MPKI cost
     of a slower stage cut.
   - Model/evidence change: `SC_SAME_EVENT_OVERRIDE`,
     `H2P_SAME_EVENT_OVERRIDE`, `LOCAL_DIR_SAME_EVENT_OVERRIDE`, and
     `ITTAGE_SAME_EVENT_TARGET` are now explicit geometry knobs. The model
     records `*_deferred_by_timing_model` counters plus `l2_ftb_late_redirect`,
     and the sweep JSON/gate require those counters per trace and per config.
   - Sweep result: the refreshed stratified 1000-branch smoke sweep keeps
     baseline at `53.2849` weighted MPKI. Deferring SC/H2P/local-direction
     overrides regresses to `55.0615` (`+1.7766`), deferring same-event ITTAGE
     target use regresses to `56.4194` (`+3.1345`), and deferring both
     regresses to `58.1960` (`+4.9111`). That makes same-event predictor
     availability a load-bearing assumption for the RTL stage plan.
   - Tests: `test_ittage_timing_model_can_defer_same_event_target_use` and
     `test_slow_direction_timing_model_defers_sc_local_and_h2p_overrides`
     cover the new knobs. Remaining work is physical/staged RTL timing
     closure, not a missing behavioural harness.

10. **L2 FTB/refill target tier**
   - Gap: production front-ends commonly keep a deeper target tier behind the
     low-latency BTB/FTB so hot branch blocks survive L1 target-table
     conflicts. The prior RTL had only the single-cycle L1 FTB plus uFTB.
   - RTL change: `ftb.sv` is now geometry-parameterized and has a resolver-
     lower-priority refill/promote port. `bpu_top.sv` instantiates an
     8192-entry, 8-way L2 FTB that trains on resolver updates, looks up one
     cycle after an L1 FTB miss, and refills the complete branch-block entry
     back into L1 on a hit.
   - Recovery behavior: delayed L2 responses are tagged with a BPU epoch and
     dropped across misprediction redirects, so wrong-path lookups cannot
     repopulate L1.
   - Tests: `bpu_l2_ftb_refills_l1_after_conflict_eviction` evicts a trained
     block from L1 while it remains resident in L2, then proves the delayed hit
     promotes it back into L1. `bpu_l2_ftb_drops_stale_refill_on_redirect`
     proves a redirect in the response window suppresses the refill.
   - Model/evidence update: the Python MPKI model now includes a separate
     `L2_FTB_ENTRIES` target tier, trains it alongside L1, records
     `l2_ftb_hit/l2_ftb_miss/l2_ftb_late_redirect`, and models the RTL's
     delayed redirect policy for call/indirect and strong-taken conditional
     misses. The expanded 50K capped sweep adds
     `synthetic:l2_ftb_target_pressure`, a 6144-site taken-target workload that
     exceeds L1 FTB capacity but fits the default L2. Baseline scores weighted
     MPKI `36.7571`; disabling L2 scores `38.9826` due to a `+100.0000` MPKI
     regression on that target-pressure trace.
   - Model tests:
     `test_l2_ftb_late_redirect_rescues_call_target_after_l1_miss`,
     `test_l2_ftb_can_be_disabled_for_ablation`, and
     `test_l2_ftb_conditional_patch_requires_strong_taken_bimodal` cover the
     late-target, ablation, and conditional guard behavior.
11. **Delayed L2 FTQ patch/redirect for always-taken target classes**
   - Gap: a production front-end should not wait until a second lookup to use
     a deeper target-tier hit when the branch class is direction-unambiguous or
     when delayed direction/RAS confidence is strong enough.
   - RTL change: `ftq.sv` now exposes its enqueue pointer and accepts a live
     patch transaction that updates the fetch contract while preserving
     prediction-time metadata. `bpu_top.sv` captures the FTQ pointer for L1
     misses; a non-stale L2 hit for `BR_CALL`, `BR_IND`, strongly-taken
     `BR_COND`, or a request-snapshot `BR_RET` patches that entry, flushes
     younger FTQ entries, and emits `late_redirect_valid/pc/ftq_idx`.
   - Conditional guard: delayed conditionals are patched only when the delayed
     bimodal slice is saturated taken; weak conditionals remain refill-only.
   - Return guard: the L2 request captures the RAS top and whether the uFTB
     already popped the return. Late return patches use the captured RAS target
     and are suppressed if the uFTB already handled the pop, avoiding double-pop
     recovery hazards.
   - Tests: `bpu_l2_ftb_patches_ftq_and_redirects_call_after_l1_miss` proves
     a call target evicted from L1 but resident in L2 produces a late redirect
     and patches the queued fetch entry before fetch consumes it.
     `bpu_l2_ftb_patches_strong_taken_conditional_after_l1_miss`,
     `bpu_l2_ftb_patches_return_from_ras_snapshot_after_l1_miss`, and
     `bpu_l2_ftb_return_does_not_double_pop_after_uftb_steer` cover the new
     delayed conditional/return steering cases.

12. **Vector redirect lanes for non-contiguous fetch-control integration**
   - Gap: the FTQ and L1I shim carried two segment records, but `bpu_top`
     still exposed only scalar prediction and scalar late-redirect ports, so a
     widened fetch-control integration had to infer the redirect stream from
     `fetch_segments`.
   - RTL change: `bpu_top.sv` now exposes
     `pred_redirect_valid[]`/`pred_redirect_pc[]` from taken prediction-time
     segments and `late_redirect_valid_lanes[]`/`late_redirect_pc_lanes[]`/
     `late_redirect_ftq_idx_lanes[]` for delayed L2 patches. Existing scalar
     `target_pc` and `late_redirect_valid/pc/ftq_idx` ports are preserved for
     compatibility.
   - Tests: `bpu_second_conditional_slot_redirects_after_first_falls_through`
     now checks that the second in-block conditional drives redirect lane 1,
     and `bpu_l2_ftb_patches_ftq_and_redirects_call_after_l1_miss` checks the
     late-redirect lane-0 compatibility path.

13. **Bounded two-ahead target-block redirect**
   - Gap: after predicting a taken branch to a different target block,
     `bpu_top` could expose only the first target. A production fetch-control
     path benefits from seeing an always-taken branch in that target block in
     the same prediction cycle when the target-array data is already resident.
   - RTL change: `ftb.sv` now has an optional second logical read view
     (`lkp2_*`) over the same target array. `bpu_top.sv` drives that view with
     the first prediction's target PC when the first redirect is taken and no
     same-block second slot already consumes lane 1. Direction-unambiguous
     target-block hits (`BR_DIRECT`, `BR_CALL`, `BR_IND`) and strongly-taken
     conditional target-block hits drive `pred_redirect_valid[1]` and
     `pred_redirect_pc[1]`. Target-block returns are also supported when the
     first branch is a call, using the call fall-through as the return target,
     or when the first branch does not mutate the RAS, using the current RAS
     top. The logical view is explicit so physical
     implementation can map it to a second SRAM read port, banking, or a small
     replica.
   - Tests: `bpu_two_ahead_target_block_direct_redirect_lane` trains two
     direct branches in consecutive target blocks and proves prediction lane 0
     carries the first target while lane 1 carries the target block's redirect.
     `bpu_two_ahead_target_block_strong_conditional_redirect_lane` covers the
     same path for a strongly-taken conditional in the target block.
     `bpu_two_ahead_target_block_return_after_call_uses_call_fallthrough`
     covers a target-block return after a predicted call and proves lane 1 uses
     the call fall-through rather than the stale stored return target.
     `target_block_two_ahead_fetch_stream_exposes_lane_one` and
     `target_block_two_ahead_fetch_stream_flush_drops_lane_one` cover the
     observational fetch-control adapter that now carries target-block lane 1
     out of the BPU/L1I frontend wrapper and drops it on redirect flush.
     `target_block_two_ahead_fetch_stream_drives_l1i_demand_in_order` and
     `target_block_two_ahead_fetch_demand_flush_drops_queued_lane_one` prove
     that the lane-1 stream can be serialized into actual L1I IFU demand
     traffic and purged before a stale queued target escapes. The demand queue
     carries each lane's FTQ index, segment index, and branch kind alongside the
     target address so later replay/redirect machinery does not lose
     provenance.
   - SoC integration change: `e1_soc_integrated.sv` now exposes
     `pred_redirect_valid_o[]`/`pred_redirect_pc_o[]` and the delayed
     late-redirect lane vectors at the structural SoC boundary instead of
     discarding them as unused BPU internals. It also exposes the ordered
   `fetch_stream_*_o` two-lane fetch-control stream with
   `fetch_stream_ready_i`; `bpu_fetch_stream_backpressures_soc_ftq_pop`
   proves SoC-level backpressure holds the FTQ head, preserves lane 1, and
   prevents the scalar L1I prefetch shim from consuming a stalled stream.
    `bpu_fetch_stream_drives_soc_l1i_demand_lanes` proves the integrated SoC
    now also exposes lane-0/lane-1 L1I IFU demand ports with FTQ/segment/kind
    provenance and demand-ready backpressure.

## Ranked remaining RTL-facing gaps

1. **Full two-taken/non-contiguous fetch**: the bounded same-block conditional
   case now carries two FTQ fetch segments, exposes both as a two-lane
   prefetch bundle, drives explicit vector redirect lanes out of `bpu_top`,
   and performs a bounded same-cycle second FTB read for direct/call/indirect,
   strongly-taken conditional, and conservative return target-block hits. The
   `ftq_to_fetch_stream` adapter makes target-block lane 1 externally visible
   as ordered fetch-control metadata, and `fetch_stream_to_l1i_demand` proves
   those taken stream targets can become ordered L1I IFU demand requests while
   retaining FTQ/segment/kind provenance. `e1_l1i_cache` now accepts a cold
   lane-1 demand into an ordered pending miss slot and launches it through an
   independent lane-1 miss/refill channel, so target-block lane 1 is no longer
   a hit-only path or serialized through the scalar fill pipe.
   `e1_soc_integrated` now surfaces the widened prediction and late-redirect
   lanes plus the ordered fetch-control stream and lane-0/lane-1 L1I demand
   ports at the SoC boundary, with ready inputs that backpressure FTQ pop until
   downstream fetch logic can accept both lanes. `e1_l1i_dual_miss_to_l2`
   now bridges the scalar and lane-1 L1I miss/refill pipes onto the production
   L2 L1I acquire/grant channel, with focused cocotb coverage for lane-1
   demux, scalar priority, and flush. The remaining integration gap is
   SoC-level instantiation of the production fetch/cache hierarchy behind
   `e1_soc_integrated`, not a missing lane-1 miss-to-L2 mechanism.
2. **Speculative history recovery survivor replay**: redirect recovery now
   restores speculative direction and target histories from the resolved FTQ
   snapshot and applies the actual resolved outcome. The remaining precision
   gap is future-looking: if the fetch policy ever preserves younger FTQ
   entries after a selective redirect, those surviving predictions will need a
   replay walk.
3. **Corrector policy**: local-history SC is implemented, enabled, and
   maintained on every resolved conditional. Base H2P and learned
   local-direction meta are enabled by the corrected GPU-weighted sweep.
   H2P meta gating, multi-perspective H2P feature slices, explicit per-PC SC
   bias, and IMLI-style loop-iteration history remain implemented and
   sweepable but default-off because their current wins are not GPU-neutral.
   Static alternate-provider TAGE is disabled by evidence, while the adaptive
   alternate-provider chooser is implemented and enabled.
4. **Predictor pipeline timing closure**: the behavioural harness now exposes
   timing knobs/counters for deferred SC, H2P, local-direction, ITTAGE, and L2
   FTB late paths, and the latest sweep shows those deferrals are costly. The
   remaining production gap is a staged RTL timing implementation or physical
   timing signoff that preserves the same effective sidecar/target latency.
5. **Real workload evidence depth**: synthetic coverage now spans 37
   generators, and `mpki_results_workload_rtl.json` replays all twenty
   available QEMU-RV64 `.btrace.json` workloads through RTL with a recorded
   `branch_replay_cap=5000`. The added `system_mix.c` traces cover
   compiler/build, compression, crypto packet handling, database/B-tree, and
   GPU-control command-buffer/fence behavior plus browser/layout,
   kernel/syscall-heavy, GC/runtime control paths, GPU memory residency,
   GPU IRQ/fence scheduling, NN delegate fallback, mobile UI frame scheduling,
   and WASM/JIT OSR behavior. That closes the previous two-trace RTL evidence
   hole and broadens general CPU/GPU-control/mobile-runtime coverage, but it is
   prefix coverage rather than a full-trace MPKI claim. Real production GPU
   traces and uncapped/full-trace captures remain evidence gaps before
   promoting any currently default-off predictor knobs.
   The RTL workload artifact now records replay coverage directly:
   `100,000` replayed branches out of `25,574,792` source branches
   (`replay_fraction=0.003910`), with per-workload replay fractions and
   `full_trace_replay=false` required by the branch-prediction gate.
   `docs/evidence/cpu_ap/bpu-workload-trace-manifest.json` now makes that
   boundary machine-checkable: it hashes all twenty staged `.btrace.json`
   traces, records `152,035,912` source instructions and `25,574,792` source
   branches, and explicitly lists the missing SPEC2017, AOSP, browser/JS, and
   production GPU trace suites. The branch-prediction gate now requires this
   manifest and cross-checks it against the RTL workload replay artifact.
   The sweep harness now supports prefix/middle/late/stratified capped windows
   through `--window-mode` / `WINDOW_MODE`, so optimisation runs can sample
   non-prefix phases without rewriting trace files. The `.btrace.json` schema,
   capture CLI, reader, and planning model now
   preserve ASID/VMID/privilege/security/workload-class context fields, so real
   traces can exercise the same partitioning path as RTL instead of relying on
   synthetic aliases only. The evidence gate also requires explicit
   `class_bucket_promotion` no-regression buckets, including `general` and
   `gpu_control`, before any positive workload MPKI claim can be asserted.
   RTL workload replay exposes the same phase-sampling control through
   `make mpki-eval-rtl WORKLOAD_WINDOW_MODE=stratified`; the
   `mpki-eval-rtl-stratified` shortcut is available for capped early/middle/late
   replay without editing environment variables. `make mpki-eval-rtl-full` and
   `make bpu-sweep-full` are now explicit uncapped aliases, and the Makefile
   forwards `WORKLOAD_MAXBR`, `WORKLOAD_WINDOW_MODE`, `MAXBR`, `WINDOW_MODE`,
   and `CONFIGS` to the underlying harnesses so long validation runs are
   reproducible from command logs. `make bpu-sweep-full-proxy-shard` now records
   an uncapped five-trace GPU/mobile/NN/WASM proxy shard; baseline beats
   `h2p_off` there (`49.5413` versus `49.5932` weighted MPKI). The companion
   `make bpu-sweep-full-io-media-shard` records the uncapped HTTP/text/file/
   video/audio shard; `h2p_lowconf_only` wins that narrower slice (`39.4707`
   versus baseline `40.2076` and `h2p_off` `39.9444`), but a `100k`
   stratified mixed-workload probe still favors baseline (`42.3553` versus
   `42.9139`) because guarded H2P regresses correlated/control-flow synthetic
   guardrails. `make bpu-sweep-full-system-gpu-shard` records the uncapped
   `gpu_control`, GC-runtime, syscall, and B-tree shard; `h2p_lowconf_only`
   wins there too (`37.6255` versus baseline `38.0666` and `h2p_off`
   `37.8209`). `make bpu-sweep-full-browser-build-crypto-shard` records the
   uncapped browser-layout, build/compiler, and crypto shard; `h2p_lowconf_only`
   wins there with no per-trace regressions (`48.5761` versus baseline
   `50.1515` and `h2p_off` `48.9479`). `make bpu-sweep-full-compression-shard`
   records the uncapped compression proxy; `h2p_lowconf_only` wins (`102.2479`
   versus baseline `103.6911`) while `h2p_off` regresses (`103.8983`). The full
   twenty-trace model sweep, agent full-trace model shards, and uncapped RTL
   replay remain open production evidence gaps.
6. **Downstream widened IFU/L1I consumption**: `ftq_to_l1i_shim` now exposes a
   widened two-lane prefetch bundle. The scalar compatibility path has an
   eight-entry ordered prefetch FIFO, so younger FTQ pops are retained while an
   older prefetch is blocked in FDIP/L1I; the regression
   `fdip_queue_keeps_younger_ftq_prefetch_under_backpressure` proves both
   lines drain in order after recovery. FDIP now consumes the two-lane bundle
   directly into an ordered receiver queue and drains both requests to the
   existing L1I prefetch port; `test_fdip_consumes_two_lane_bundle_in_order`
   plus the duplicate/recent-line/pollution-throttle FDIP tests and the updated
   frontend wide-bundle test cover that path. L1I now accepts cold lane-1 IFU
   demand into a pending miss slot and services it through a separate lane-1
   miss/refill channel
   (`target_block_two_ahead_fetch_stream_accepts_cold_lane_one_miss`).
   `e1_l1i_dual_miss_to_l2` then arbitrates scalar and lane-1 misses onto the
   L2 L1I acquire/grant channel and demuxes returned line beats back to the
   originating refill lane. The remaining non-BPU work is full SoC/core/cache
   top instantiation behind the already-exposed demand ports.
