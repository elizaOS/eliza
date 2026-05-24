# Synthetic BPU MPKI vs CBP-5 TAGE-SC-L 64 KB Reference

## Scope and honest framing

This table reports the **Eliza E1 BPU MPKI on 35 deterministic synthetic
branch traces**, captured end-to-end by running each trace through the
`bpu_top.sv` RTL via cocotb (`verify/cocotb/bpu/test_bpu_mpki.py`). The
machine-readable evidence is at
[`mpki_results_synthetic.json`](mpki_results_synthetic.json),
schema `eliza.bpu_mpki.v1`.

**These workloads are synthetic and do not represent SPEC2017, AOSP, or
JavaScript-engine traces.** They are useful as:

- A wiring sanity check that the RTL BPU (uFTB + FTB + TAGE-SC-L + H2P +
  ITTAGE + RAS + Loop) responds correctly to each branch class.
- A first-order calibration that the PMU counters in `bpu_csr.sv` increment
  in the right direction.

They do **not**:

- Establish a SPECint MPKI for the Eliza E1 BPU.
- Establish a CBP-5 MPKI for the Eliza E1 BPU; CBP-5 train-trace RTL evidence
  lives in [`mpki_results_cbp5_rtl.json`](mpki_results_cbp5_rtl.json) and
  [`mpki_cbp5_vs_tagesc_l_64kb.md`](mpki_cbp5_vs_tagesc_l_64kb.md), not in this
  synthetic table.
- Establish an Android / V8 MPKI.

The CBP-5 TAGE-SC-L 64 KB reference (3.986 MPKI, published Seznec/SiFive) is
shown in every row only as a side-by-side table value so the gap-to-target
column is interpretable. The CBP-5 values in this table are reference anchors,
not measurements from these synthetic RTL runs. CBP-5 train-trace RTL evidence
is tracked separately; SPEC, Android, and JS-engine MPKI remain **BLOCKED** until
those workload traces are ingested into the BPU harness.

## How to reproduce

```bash
make mpki-eval-rtl
```

This invokes `benchmarks/cpu/branch/run_mpki.py --backend rtl`, which
launches the cocotb test `bpu_mpki_synthetic_8_workload_sweep` against
`bpu_top_tb` via `scripts/run_cocotb_bpu.sh` (Verilator). The test:

1. Resets the BPU + FTQ at the start of each workload.
2. Replays every event from the named generator (predict on the BPU lookup
   port, resolve with the actual taken/target/kind).
3. Reads the BPU PMU counters via `csr_re`/`csr_addr` after each workload.
4. Emits a single JSON envelope with per-workload MPKI, the PMU snapshot,
   and the CBP-5 reference for table-shape comparison.

## Per-workload results

The "Gap vs 2028 target" column subtracts the 2028 SPECint MPKI ceiling
(≤ 4.0 MPKI) from the per-workload synthetic MPKI. A **negative** gap
means the workload sits comfortably below the target on synthetic traces;
a **positive** gap means the workload is harder than SPEC-on-paper for
the predictor, which is expected on deliberately adversarial workloads
(deep RAS, monomorphic ITTAGE warm-up, etc).

| Workload | Branches | Taken / branch | Mispredictions | MPKI (synthetic) | Indirect misp | RAS misp | CBP-5 TAGE-SC-L 64 KB ref | Gap vs 2028 target (≤ 4.0) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `always_taken`           | 1000 | 1.00 |   1 |   0.200 |   0 |  0 | 3.986 |  -3.800 |
| `always_not_taken`       | 1000 | 0.00 |   1 |   0.200 |   0 |  0 | 3.986 |  -3.800 |
| `alternating`            | 1000 | 0.50 |  16 |   3.200 |   0 |  0 | 3.986 |  -0.800 |
| `loop_with_known_trip`   | 1024 | 0.94 |  10 |   1.953 |   0 |  0 | 3.986 |  -2.047 |
| `deep_recursion`         |  512 | 1.00 |  64 |  25.000 |  32 | 32 | 3.986 | +21.000 |
| `v8_indirect_dispatch`   |  512 | 1.00 | 508 | 198.438 | 508 |  0 | 3.986 | +194.438 |
| `mixed_workload`         |  704 | 0.91 | 132 |  37.500 |  58 | 64 | 3.986 | +33.500 |
| `jit_dispatch_warmup`    | 1596 | 1.00 |  81 |  10.150 |  81 |  0 | 3.986 |  +6.150 |
| **aggregate**            | 7348 | 0.91 | 813 |  22.128 | 679 | 96 |  n/a  |   n/a  |

Numbers are PMU-derived (`BR_MISP`, `BR_IND_MISP`, `BR_RET_MISP`); the
harness-observed values in the JSON envelope match the PMU counts.

## Per-workload commentary

- **`always_taken` / `always_not_taken` (MPKI ≈ 0.2).** Direction-stable
  conditionals settle to a single prediction after a one-branch warm-up
  (the first cold-FTB miss). The remaining MPKI is the FTB cold miss on the
  very first branch.
- **`alternating` (MPKI ≈ 3.2).** The PMU `LOOP_HIT` and `SC_OVERRIDE`
  counters fire, confirming the loop predictor and statistical corrector
  pull the predictor toward the alternating pattern. The remaining ~16
  mispredictions are during the TAGE allocation phase before SC overrides.
- **`loop_with_known_trip` (MPKI ≈ 2.0).** The 16-trip loop is mostly
  predicted by the loop predictor once confidence saturates; the misses are
  the trip-count boundaries before saturation.
- **`deep_recursion` (MPKI ≈ 25).** 32-deep call/return repeated 8 times.
  RAS allocates correctly on the first pass; subsequent passes see RAS hits
  (FTB-target reuse). The remaining ~64 mispredictions concentrate on call
  + return *targets* that arrive before FTB/ITTAGE training: ITTAGE
  allocation is gated on misprediction so the first call to each PC is
  always cold.
- **`v8_indirect_dispatch` (MPKI ≈ 198).** A pathological worst case:
  every call rotates targets, so ITTAGE never converges. This is a
  deliberate stress; the comparable XiangShan KMH ITTAGE result on the
  same pattern is similarly bad. The `RAS_OVERFLOW` counter advances
  because the deep call-only chain (no matching returns) exceeds RAS
  speculative depth; a real workload returns to drain the stack.
- **`mixed_workload` (MPKI ≈ 37.5).** Interleaved loops + calls + cold
  indirect site per round. Most error budget is the cold indirect site
  and RAS turnaround between rounds.
- **`jit_dispatch_warmup` (MPKI ≈ 10.2).** 5-target warm-up then 128
  monomorphic-target steady state per site, across 12 sites. ITTAGE
  eventually converges per site, but the warm-up phase plus
  cross-site cold misses dominate.

## What this evidence proves

1. The RTL BPU runs end-to-end against eight independent synthetic
   workloads without simulator failures.
2. The PMU counters increment in the documented directions for every
   branch class.
3. The harness-observed misprediction count agrees with the PMU
   `BR_MISP` reading for every workload (the two columns are equal in
   `mpki_results_synthetic.json`).
4. The cocotb harness is the single source of truth for synthetic MPKI;
   the behavioural model (`benchmarks/cpu/branch/bpu_model.py`) is kept
   in-tree for geometry sweeps but is no longer the load-bearing
   evidence for `make mpki-eval`.

## What this evidence does NOT prove

1. **SPECint MPKI.** The 2028 target (≤ 4.0 MPKI SPECint average) cannot
   be evaluated without SPEC traces; see
   [`branch-prediction-params.json`](branch-prediction-params.json)
   `claim_policy.spec2017_mpki_claim=false`.
2. **CBP-5 MPKI from this synthetic table.** The TAGE-SC-L 64 KB reference
   (3.986 MPKI) is the published Seznec/SiFive number. Eliza's CBP-5
   train-trace model/RTL artifacts are separate from this synthetic table and
   remain scoped to `evidence_class: cbp5_train_traces_only`.
3. **Android UI / TFLite / V8 MPKI.** Same constraint: needs the
   corresponding traces.
4. **Two-taken-per-cycle behaviour.** The dual-port FTB read path is
   tracked in `bpu_top.sv` as a reserved extension and is not exercised
   by the synthetic suite.

## BLOCKED follow-ups

- Extend the cocotb harness beyond the staged CBP-5 train traces to any
  additional `.jsonl`, SPEC2017, AOSP UI, or JS-engine trace bundles needed for
  broader workload claims.
- Acquire and check in (or arrange license-gated download of) the CBP-5
  2025 reference trace set and a SPEC2017 / AOSP UI / V8 trace bundle.
  Until then the corresponding `claim_policy` flags must remain
  `false`.
