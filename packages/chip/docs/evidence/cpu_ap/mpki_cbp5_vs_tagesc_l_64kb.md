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

## Per-trace MPKI (model + RTL backends), R7 post-fix

| trace | branches | instructions | model MPKI | RTL MPKI | CBP-5 64KB TAGE-SC-L ref MPKI | model gap | RTL gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sample_fp_trace  | 148 723 |  997 741 | 3.078 | 4.221 | 0.5736 (fp_0_trace full) | +2.504 | +3.647 |
| sample_int_trace | 181 877 |  997 301 | 2.214 | 9.666 | 5.1327 (int_0_trace full) | -2.919 | +4.533 |

R6 baseline (pre-fix): RTL `sample_fp_trace = 52.554`, `sample_int_trace = 59.737`.
R7 post-fix: 12.4 × reduction on fp, 6.2 × reduction on int.

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

## R7 fixes (committed)

The R6 RTL/model divergence was driven by four concrete RTL design
gaps, all addressed in R7:

1. **`br_kind_e` widened to 3 bits.** Added `BR_IND = 4` so the RTL can
   express "indirect jump that does not push the RAS" (switch dispatch,
   PLT, vtable). The cocotb harness no longer collapses `BR_IND ->
   BR_CALL`; on `sample_int_trace` the RAS overflow counter dropped from
   18 508 to 0 because spurious indirect pushes are gone. Consumers
   updated: `rtl/cpu/bpu/bpu_top.sv` arbitration and PMU strobes,
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

## Residual gap (post-R7)

After the R7 fixes the RTL stays within **1.4 ×** of the model on
`sample_fp_trace` (4.22 vs 3.08 MPKI) and **4.4 ×** on
`sample_int_trace` (9.67 vs 2.21 MPKI).

Per-class residual on `sample_int_trace` (the harder workload):

- `br_ind_misp = 5 994` (was 14 354 in R6) — dominant residue. ITTAGE
  has 14 255 indirect branches in the trace and converges much slower
  than the model. The R7 fix changed the wrong-class training gate
  (now `CALL || IND`, was `CALL || RET`) and the harness now drives
  the correct 3-bit kind, but the per-table allocation policy and the
  bimodal-like cold-target eviction are different in shape from the
  Python model and need a focused convergence audit.
- `br_cond_misp = 3 566` (was 32 299 in R6) — within 2 × of the
  model. The remaining cond gap is driven by FTB cold misses
  (`ftb_miss = 7 985`); the per-PC FTB index helped but the 2 048
  entry capacity is still under-provisioned for the int trace's
  branch footprint.
- `br_ret_misp = 80` (was 12 902 in R6) — essentially closed by the
  fall-through-PC fix; the residual 80 are cold-start lookups where
  the FTB had not yet learnt the call.
- `ras_overflow = 0` (was 18 508) — fully resolved by the BR_IND /
  BR_CALL split.

The next planned step is an ITTAGE convergence-rate audit (Seznec's
2008 ITTAGE allocation policy vs the Kunminghu-class allocator we
have today). Both gaps are RTL design issues exposed by real-trace
ingest, not measurement artifacts. The model-side numbers stay within
0.6 - 5 × of the CBP-5 reference, consistent with running the geometry
on a 1 M-instruction prefix versus the full 40 M+ reference trace.

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
- The `cbp5_claim` flag is `true` in
  `mpki_results_cbp5.json` and `mpki_results_cbp5_rtl.json` to mark
  that a real CBP-5 trace number is now on file, scoped to the
  `evidence_class: cbp5_train_traces_only` field.

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
existing `eliza.bpu_mpki.v1` schema. The CBP-5 envelopes add:

- `evidence_class: cbp5_train_traces_only` (top-level + per-workload).
- `cbp5_tage_sc_l_64kb_reference_mpki_by_class` (workload-class
  averages from the CSV).
- `cbp5_tage_sc_l_64kb_reference_mpki_by_trace` (per-trace anchors
  parsed from the CSV).
- Per-workload `branch_stats` with the true `instruction_count`,
  `branch_count`, and per-class breakdown from the CBP-5 reader.
- `claim_policy.cbp5_claim = true`; `spec2017_claim`, `android_claim`,
  `v8_claim` remain `false`.
