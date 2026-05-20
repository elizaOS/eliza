# Multi-Corner STA — MMMC POCV/SOCV with LVF

## Scope

This document records the multi-corner static-timing-analysis methodology
across the open-tooling MVP (today, Sky130 SS/TT/FF x min/max RC) and the
2028 advanced-node target (100-200 corners typical at N3/N2, ML-pruned to
32-64). It is the human-readable companion to
`docs/evidence/pd/multi-corner-sta-evidence.yaml`.

## MVP (Sky130 + IHP SG13G2): 6 corners

| Process | RC | Operating | Use |
| --- | --- | --- | --- |
| SS | min | 1.62 V / 125 C | setup-worst min-RC |
| SS | max | 1.62 V / 125 C | setup-worst max-RC |
| TT | min | 1.80 V / 25 C | typical min-RC |
| TT | max | 1.80 V / 25 C | typical max-RC |
| FF | min | 1.98 V / -40 C | hold-worst min-RC |
| FF | max | 1.98 V / -40 C | hold-worst max-RC |

Driver: `scripts/run_multi_corner_sta.py` calls OpenSTA (or OpenROAD's
internal STA engine) once per corner. Outputs:

- `{corner}.tcl` script that read_liberty / read_verilog / read_sdc /
  read_spef and runs report_checks.
- `{corner}.rpt` four-line digest (setup/hold WNS + TNS).
- `multi_corner_sta.json` aggregate summary.

OpenSTA is not installed natively on every developer host. The
container-friendly invocation is:

```sh
docker run --rm -v "$PWD":/work -w /work \
    -e PDK_ROOT=/work/external/pdks \
    ghcr.io/efabless/openlane2:2.4.0.dev1 \
    python3 scripts/run_multi_corner_sta.py \
        --run-dir pd/openlane/runs/<RUN_TAG> \
        --out-dir build/pd/multi_corner_sta/<RUN_TAG> \
        --pdk-root /work/external/pdks/volare/sky130/versions/c6d73a35f524070e85faff4a6a9eef49553ebc2b
```

This image ships OpenSTA at `/nix/store/.../opensta/bin/sta` which is on
PATH inside the container.

Acceptance (Stage 1):

- All 6 corners run to completion.
- TT_max setup_wns >= 0.
- FF_min hold_wns >= 0.
- SS_max setup_wns >= 0 OR the failing paths land in the architectural
  exception list under `pd/constraints/`.

## Stage 3 (advanced node, BLOCKED on commercial EDA)

At N3/N2 the multi-corner space is **fundamentally bigger**:

| Dimension | Sky130 | N3/N2 |
| --- | --- | --- |
| Process | 3 (SS/TT/FF) | 5+ (SS/SF/TT/FS/FF) |
| Voltage | 1 nominal +/- 10 % | 3-5 (NOM, OV, UV, ALV, retention) |
| Temperature | -40/25/125 | full mil + ambient self-heat |
| RC | 2 (min/max) | 5+ (cworst/cbest/rcworst/rcbest/typ) |
| AOCV/POCV/SOCV | OCV derate | LVF Liberty + path-based OCV |
| Aging | none | EM/HCI/NBTI aging-aware re-spin |

Full Cartesian product is 100-200 corners. Running all of them is
prohibitive. The industry-standard approach in 2025+ is:

- **POCV/SOCV with LVF Liberty:** statistical delay model rather than worst
  case + derate. Cuts pessimism by 5-15 %.
- **ML corner pruning:** train a regressor on a subset of corners to
  predict which corners are most likely to gate setup/hold/slew. Run the
  expensive PrimeTime path-based STA only on the top 32-64 predicted
  corners.
- **Path-based vs graph-based:** graph-based first pass for coverage,
  path-based second pass for the violators.

Tool stack: PrimeTime SI / Tempus for path-based, plus a thin ML predictor
trained on historical reports. This is **all** BLOCKED on the commercial
EDA gate (`docs/evidence/pd/commercial-eda-gate.yaml`).

## Why exercise STA methodology now

The methodology-validation discipline matters:

- Driving multi-corner STA on Sky130 forces us to discover SDC bugs,
  exception leakage, and corner-skew bugs at a stage where one Liberty
  per corner is fast and free.
- The aggregate JSON schema (`eliza.pd_multi_corner_sta.v1`) is the same
  shape we will use at the advanced node. Only the corner count and the
  derate model change.

## What unblocks the multi-corner-sta-evidence gate

For Stage 1:

- A full Sky130 release run produces all 6 corner reports.
- All 6 corners have setup_wns >= 0 (or documented exception).
- All 6 corners have hold_wns >= 0.

For Stage 3:

- Commercial-EDA gate unblocks.
- PrimeTime SI runs path-based STA on >= 32 N3/N2 corners.
- POCV/SOCV LVF Liberty in use.
- ML corner-pruning trained and validated against the full Cartesian
  subset for at least one block.
