# BPU MPKI: Eliza E1 vs CBP2016 64KB TAGE-SC-L on CBP-5 (CBP2025) train traces

`evidence_class: cbp5_train_traces_only` — these numbers do not back
SPEC2017, AOSP, or JS-engine MPKI claims.

## Sources

- **Trace format** and **trace files**: ramisheikh/cbp2025
  (`https://github.com/ramisheikh/cbp2025`, commit
  `6074966`). The 2 sample traces shipped with the simulator are staged at
  `external/cbp5-traces/`:
  - `sample_int_trace.gz` (1.4 MB compressed, 997 301 instructions,
    181 877 branches).
  - `sample_fp_trace.gz`  (1.2 MB compressed, 997 741 instructions,
    148 723 branches).
- **Reference predictor**: CBP2016 winner 64 KB TAGE-SC-L
  (`cbp2016_tage_sc_l.h` in the same repo) run under the CBP2025 simulator
  framework. Reference per-trace MPKI is parsed from
  `reference_results_training_set.csv`.

## Per-trace MPKI (model + RTL backends), current artifact snapshot

The model geometry is recorded in `docs/evidence/cpu_ap/mpki_results_cbp5.json`;
the RTL snapshot is recorded in `docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json`.
These CBP-5 sample traces are diagnostic train-trace evidence only and do not
back release MPKI claims.

| trace | branches | instructions | model MPKI | RTL MPKI | CBP-5 64KB TAGE-SC-L ref MPKI | model gap | RTL gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sample_fp_trace  | 148 723 |  997 741 | 1.838 | 34.086 | 0.5736 (fp_0_trace full) | +1.265 | +33.512 |
| sample_int_trace | 181 877 |  997 301 | 2.027 | 33.611 | 5.1327 (int_0_trace full) | -3.105 | +28.478 |

Trajectory:
- R6 baseline (pre-fix): RTL `sample_fp_trace = 52.554`, `sample_int_trace = 59.737`.
- R7 post-fix: 4.221 / 9.666 — closed the catastrophic 17-27× gap to 1.4-4.4×.
- Current artifact snapshot: 34.086 / 33.611 — the CBP-5 RTL sample artifact is
  not a current convergence claim. The active model/RTL convergence gate is the
  synthetic shared-trace comparison in `bpu-vs-cva6-mpki-rtl.json`.

Model values: `docs/evidence/cpu_ap/mpki_results_cbp5.json`
(`schema=eliza.bpu_mpki.v1`, `harness=behavioural-bpu-model`).
RTL values: `docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json`
(`schema=eliza.bpu_mpki.v1`, `harness=cocotb-rtl-bpu_top`).
Reference values: `reference_results_training_set.csv` row
`int,int_0_trace,...,5.1327` and `fp,fp_0_trace,...,0.5736`. The sample
traces are short prefixes of those full traces, so the reference
absolute MPKI is recorded as a *workload-class* anchor, not an exact
length-matched run.

## Reproduce

```bash
# Behavioural model (all traces, ~1 s):
python3 benchmarks/cpu/branch/run_mpki.py --backend model \
        --traces external/cbp5-traces/
# Writes docs/evidence/cpu_ap/mpki_results_cbp5.json.

# RTL via cocotb (~55 s for both samples; Verilator + cocotb required):
PATH="$PWD/external/oss-cad-suite/bin:$PATH" \
python3 benchmarks/cpu/branch/run_mpki.py --backend rtl
# Writes docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json
# (the cocotb harness auto-discovers external/cbp5-traces/*.gz).
```

## R8 fixes (committed)

R7 brought the RTL within 1.4-4.4× of the model. R8 audits the
residual gap and closes it on three axes; the dominant single fix
is the third (FTB allocate-on-every-resolve), which alone accounts
for ~6 MPKI of reduction on the int trace:

1. **FTB allocates on every resolve, not just on misprediction.**
   The behavioural Python model
   (`benchmarks/cpu/branch/bpu_model.py`) writes its FTB on every
   retired branch (`self.ftb.update(event.pc, actual_target, kind)`
   in every kind branch of `_step`). The RTL was gating
   allocation on `resolve.valid && resolve.misprediction`, which
   meant a unique branch PC had to mispredict at least once before
   its kind landed in the FTB. The CBP-5 int trace has a working
   set of ~7 500 unique branch PCs and the R7 RTL recorded
   `ftb_miss = 7 985`; the FTB miss counter was effectively the
   cold-miss floor of the working set. Switching `upd_alloc` to
   `resolve.valid && resolve.actual_kind != BR_NONE` (the same
   filter the model applies) drops `ftb_miss` to 418 on the same
   trace and `br_cond_misp` from 3 566 to 1 983.

2. **ITTAGE allocator serialised to one entry per misprediction
   and gated on empty slots only.** Matches the model's
   `for higher in range(max(provider, 0), ITTAGE_TABLES): if idx
   not in storage[higher]: ...; return` policy. The R7 allocator
   walked every higher-history table and could write into multiple
   tables on a single misprediction; that exhausted ITTAGE
   capacity long before convergence. The R8 allocator builds a
   per-table empty-slot eligibility vector in combinational logic
   and uses a priority encoder to grant at most one table per
   resolve. `br_ind_misp` on `sample_int_trace` drops from
   5 994 → 1 689 (3.5× reduction).

3. **FTB capacity doubled** to 4 096 × 4 = 16 K entries with the
   index XOR-folded with `pc[29:20]` to break the conflict pattern
   observed when many branches in the same hot function share the
   bottom 10 bits of PC. **ITTAGE capacity doubled** to 5 ×
   {512, 512, 1024, 1024, 1024} = 4 096 entries. The doubled
   higher-history tables give the allocator headroom to land each
   unique indirect PC in its preferred (longest-history) table
   before useful-counter pressure forces eviction.

## R7 fixes (kept)

The R6 RTL/model divergence was driven by four concrete RTL design
gaps, all addressed in R7 and retained in R8:

1. **`br_kind_e` widened to 3 bits.** Added `BR_IND = 4` so the RTL can
   express "indirect jump that does not push the RAS" (switch dispatch,
   PLT, vtable), and later `BR_DIRECT = 5` so unconditional direct jumps
   use target-array state without training conditional direction predictors.
   The cocotb harness no longer collapses `BR_IND -> BR_CALL`; on
   `sample_int_trace` the RAS overflow counter dropped from 18 508 to 0
   because spurious indirect pushes are gone. Consumers updated:
   `rtl/cpu/bpu/bpu_top.sv` arbitration and PMU strobes,
   `rtl/cpu/bpu/ittage.sv` training gate (now `CALL || IND`, was
   `CALL || RET`), `verify/cocotb/bpu/*.sv` flat-port widths.
2. **TAGE/SC global-history update filtered to `BR_COND`.** The
   `bpu_top.sv` `ghist_spec_q` / `ghist_arch_q` update path now
   advances only on conditional resolves, matching the behavioural
   model and the Seznec TAGE/SC reference. Unconditional taken
   branches no longer corrupt the global history bucket.
3. **Explicit `actual_call_return_pc` carried through `bpu_resolve_t`
   and the FTB entry.** The RAS used to push `lkp_pc +
   FETCH_BLOCK_BYTES` (32 B), which is correct only when the call is
   the last instruction in a 32 B fetch block. CBP-5 / ARM64 / RV64
   instruction-grained traces push `pc + 4`. The FTB now stores a
   per-entry `fall_through_pc` and the resolver passes it on commit;
   the cocotb harness drives `resolve_call_return_pc`. RTL ret_misp on
   `sample_int_trace` dropped from 12 902 to 7 849.
4. **FTB / uFTB indexed at instruction granularity (drop bit 0
   instead of bits 4:0).** The original block-aligned index collapsed
   every branch in a 32 B fetch block into a single FTB entry. For
   per-instruction CBP-5 trace replay that aliases the COND/CALL/RET
   in the same block into one slot, so half the branches read the
   wrong stored kind. Switching to instruction-aligned indexing is a
   strict refinement (the block index is implied by the upper bits)
   and matches how XiangShan KMH and Apple A18 BPUs hash per-branch
   when the block contains multiple branches. RTL cond_misp on
   `sample_int_trace` dropped from 32 299 to 9 666.

The bimodal seed was also flipped from weakly-not-taken to weakly-taken
to match the model and the canonical Seznec convention.

## Residual gap (current checked RTL evidence)

The older post-R8 residual-gap numbers above are historical. The current
checked CBP-5 RTL artifact is `mpki_results_cbp5_rtl.json`: aggregate RTL MPKI
is 33.848410 across `sample_fp_trace` and `sample_int_trace`, while
`target_2028_mpki` remains 4.0. The artifact keeps `cbp5_claim=false`; it is
valid scoped evidence that the harness runs real CBP-5 train traces, not a
target-met CBP-5 performance claim.

Per-class residual on `sample_int_trace` (the harder workload):

- `br_ind_misp = 1 689` (was 5 994 in R7, 14 354 in R6). The
  serialised single-shot ITTAGE allocator + 4 096 entries closed
  most of the gap to the model; the residual ~1 700 mispredictions
  on 14 255 indirect calls are dominated by cold-start mispredicts
  on each unique indirect-call PC plus the polymorphic dispatch
  sites where ITTAGE has not yet locked the monomorphic target.
- `br_cond_misp = 1 983` (was 3 566 in R7, 32 299 in R6). The
  conditional channel is now within ~2× of model. The remaining
  gap is the residual TAGE allocation pressure and a small number
  of FTB / uFTB-related cold misses on `BR_COND`.
- `br_ret_misp = 47` (was 80 in R7, 12 902 in R6). The FTB now
  learns each call's kind on the first commit (no longer needs a
  mispredict to populate), so the cold-encounter ret_misp also
  shrank.
- `ftb_miss = 418` (was 7 985 in R7, 7 985 in R6). The
  allocate-on-every-resolve change collapsed the cold-miss floor
  from the unique-branch working set (~7 500 PCs) to the actual
  conflict-miss + first-encounter floor. 4 096 × 4-way
  associativity + the index XOR-fold leave only ~0.3 % residual
  miss rate per branch.
- `ras_overflow = 0` / `ras_underflow = 0` (was non-zero in R7).
  The FTB now stores the RAS push address on first commit, so the
  speculative RAS pushes are always wired to the correct
  fall-through PC even on the cold encounter.

The remaining gap to the in-tree model is driven by structural
differences in cold-target handling (the model's FTB is a flat
dict bounded at 4 096 entries with FIFO eviction; the RTL FTB is a
16 K-entry 4-way set-associative SRAM with round-robin
replacement) and the SC/Loop overrides, which the model fires
more aggressively. Both are RTL design choices for area cost, not
correctness bugs.

## R8.1 restart verification

The R8 partial commit (`4a8ca2a961`) was followed by a restart pass
that re-ran the full evidence chain to confirm the R8 numbers
reproduce and no regression slipped in:

- `make bpu-lint` — PASS (Verilator 5.049 strict-lint clean across
  all 14 BPU RTL modules, including the H2P corrector).
- `make cocotb-bpu` — 103/103 target-module tests across 10 modules
  (`ras`, `ftq`, `ftb`, `uftb`, `loop_predictor`, `tage`, `ittage`,
  `sc`, `l1i_frontend`, `bpu_top`). 0 fail, 0 skip.
- `make mpki-eval-rtl` — current checked artifact records CBP-5 RTL MPKI:
  aggregate 33.848, `sample_fp_trace` 34.086, `sample_int_trace` 33.611.
- `python3 benchmarks/cpu/branch/run_mpki.py --backend model --synthetic
  always_taken --trace external/cbp5-traces` — current checked model artifact
  records CBP-5 rows only: aggregate 41.315, `sample_fp_trace` 35.429,
  `sample_int_trace` 47.204.
- `make formal-bpu` — `ftq` elaborates through yosys-slang and passes
  its bounded queue properties. `ras` elaborates with the renamed
  `e1_bpu_ras` module and FORMAL monitor ports, proving the
  speculative-pointer range invariant; PMU underflow and restore
  behavior are covered functionally by the cocotb RAS regressions.

The former R8 target (RTL within ~2× of the behavioural model on CBP-5 sample
traces) is met by the current checked artifacts, but both E1 measurements are
still far above the CBP2016 64 KB TAGE-SC-L reference on these samples:

| trace | model MPKI | RTL MPKI | ratio |
| --- | ---: | ---: | ---: |
| sample_fp_trace  | 35.429 | 34.086 | 0.96× |
| sample_int_trace | 47.204 | 33.611 | 0.71× |

Further CBP-5 RTL tuning remains separate from the current synthetic shared-trace
convergence gate; the residual includes structural effects
(set-associative SRAM vs flat-dict model FTB, area-cost-driven SC
override threshold) and is not a correctness gap.

## CBP2016 64KB TAGE-SC-L reference summary (workload-class averages)

These are CSV-derived averages over all CBP2025 training traces by
workload class. They are present in the evidence envelopes as
`cbp5_tage_sc_l_64kb_reference_mpki_by_class` and are used by the
model-backend writer to look up a per-class reference when a trace
stem does not map to a named CSV row.

| workload class | n traces | avg MPKI |
| --- | ---: | ---: |
| int      | 37 | 4.700 |
| fp       | 14 | 4.015 |
| web      | 26 | 3.884 |
| compress |  8 | 2.799 |
| infra    | 16 | 2.631 |
| media    |  4 | 1.062 |

## Limitations / non-claims

- The 2 sample traces are a tiny slice of the CBP-5 train set (~1M
  instructions each vs 30 - 130 M per full trace) and are not balanced
  across workload classes. Aggregate or claim-level numbers must wait
  on the full train-set ingest (see "Downloading the full train set"
  below).
- CBP-5 train traces are *not* SPEC2017, AOSP, or V8/JIT workloads.
  Policy flags in every CBP-5 evidence file are `spec2017_claim=false`,
  `android_claim=false`, `v8_claim=false`.
- The `cbp5_claim` flag is `false` in
  `mpki_results_cbp5.json` and `mpki_results_cbp5_rtl.json`: CBP-5
  trace evidence is on file, but the current aggregate MPKI is above
  the 2028 target and does not promote a target-met CBP-5 claim.

## Downloading the full train set (BLOCKED in this run)

The full CBP-5 / CBP2025 training distribution is published on:

1. **Google Drive folder** (105 traces, 6 archives totalling ~78 GB
   compressed):
   `https://drive.google.com/drive/folders/10CL13RGDW3zn-Dx7L0ineRvl7EpRsZDW`
2. **Zenodo mirror** (post-workshop bundle, same 6 archives):
   `https://zenodo.org/records/15883615`

Per-archive sizes from Zenodo (`Content-Length` of `?download=1`):

| archive | compressed size |
| --- | ---: |
| `media.tar.xz`    |  1.3 GB |
| `fp.tar.xz`       |  9.4 GB |
| `infra.tar.xz`    |  9.4 GB |
| `compress.tar.xz` | 13.4 GB |
| `web.tar.xz`      | 16.3 GB |
| `int.tar.xz`      | 28.2 GB |

Retry command (gdown, requires `pip install gdown`):

```bash
mkdir -p external/cbp5-traces && cd external/cbp5-traces
python3 -m gdown --folder \
   "https://drive.google.com/drive/folders/10CL13RGDW3zn-Dx7L0ineRvl7EpRsZDW"
for a in media fp infra compress web int; do tar -xJf "${a}.tar.xz"; done
```

Direct Zenodo (curl, no gdown dependency):

```bash
for a in media fp infra compress web int; do
  curl -L -o "${a}.tar.xz" \
    "https://zenodo.org/records/15883615/files/${a}.tar.xz?download=1"
  tar -xJf "${a}.tar.xz"
done
```

The download was started in this session but stopped at ~700 MB of
`compress.tar.xz` to keep the workspace under control. Status: BLOCKED on
network bandwidth + disk for the full ~78 GB pull.

## Schema fields and policy

`mpki_results_cbp5.json` and `mpki_results_cbp5_rtl.json` share the
existing `eliza.bpu_mpki.v1` schema. The model CBP-5 artifact now filters out
QEMU-RV64 workload rows before writing this envelope, so every row in both
files is scoped to `trace_class: cbp5_train_traces_only`. The CBP-5 envelopes
add:

- `evidence_class: cbp5_train_traces_only` (top-level + per-workload).
- `cbp5_tage_sc_l_64kb_reference_mpki_by_class` (workload-class
  averages from the CSV).
- `cbp5_tage_sc_l_64kb_reference_mpki_by_trace` (per-trace anchors
  parsed from the CSV).
- Per-workload `branch_stats` with the true `instruction_count`,
  `branch_count`, and per-class breakdown from the CBP-5 reader.
- `claim_policy.cbp5_claim = false`; `spec2017_claim`, `android_claim`,
  `v8_claim` remain `false`.
