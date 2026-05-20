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

## Per-trace MPKI (model + RTL backends)

| trace | branches | instructions | model MPKI | RTL MPKI | CBP-5 64KB TAGE-SC-L ref MPKI | model gap | RTL gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sample_fp_trace  | 148 723 |  997 741 | 3.078 | 52.554 | 0.5736 (fp_0_trace full) | +2.504 | +51.980 |
| sample_int_trace | 181 877 |  997 301 | 2.214 | 59.737 | 5.1327 (int_0_trace full) | -2.919 | +54.605 |

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

## Gap analysis (calibration finding)

The two backends diverge by **17 - 27 x** on the same traces. The RTL
result is dominated by two architecturally explicit gaps:

1. **No distinct indirect-jump kind in `bpu_pkg.sv`.** `br_kind_e` is 2
   bits with values `{BR_NONE, BR_COND, BR_CALL, BR_RET}`. There is no
   way to express "indirect jump that does not push the RAS". The CBP-5
   training mix has substantial uncondIndBr traffic (e.g. switch
   dispatch, PLT, vtable): 6 235 in `sample_int_trace` and 1 in
   `sample_fp_trace`. The cocotb harness collapses model-side `BR_IND`
   into `BR_CALL` (`_rtl_kind_for` in
   `verify/cocotb/bpu/test_bpu_mpki.py`) because the RTL has no other
   slot. Every spurious push then desynchronises the RAS:
   `pmu_counters_delta.ras_overflow = 18 508` on `sample_int_trace`.
2. **Cond mispredict rate is high (24 - 27 %) on real traces.** The
   behavioural model gets 1.3 - 2.4 % on the same traces with the same
   TAGE geometry. The RTL TAGE-SC-L mix is wired to take *every* taken
   branch into the global history; with thousands of taken
   uncond/call/ret events between cond updates, the active history
   bucket collapses to a near-constant pattern that prevents
   per-PC tag separation.

Both gaps are RTL design issues exposed by the first real-trace run,
not measurement artifacts. Followup tickets:

- Widen `br_kind_e` (or add an `is_call` predicate decoded separately
  from `kind`) so the RTL can express indirect-jump-without-RAS-push.
- Audit the history-update path in `tage.sv` / `sc.sv`: filter the
  global history to conditional branches only, mirroring the
  behavioural model.

The model-side numbers are the better calibrated of the two and are
within 0.6 - 5x of the CBP-5 reference, which is consistent with running
the geometry on a 1 M-instruction prefix versus the full 40 M+
reference trace.

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
