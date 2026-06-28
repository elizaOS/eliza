# Multi-Corner STA

## Scope

This document records the multi-corner static-timing-analysis methodology for
the open-tooling flow that runs today: Sky130 (and the other open PDKs) driven
by OpenSTA across the PVT and RC corners declared in the corner manifests, with
graph-based OCV margin derates. It is the human-readable companion to
`docs/evidence/pd/multi-corner-sta-evidence.yaml`.

The driver is scenario-DB driven: it builds an `eliza.pd_mmmc_scenario.v1` set
from `pd/corner-manifests/<node_id>.yaml` and runs OpenSTA once per scenario.
See [mmmc-scenario-db.md](mmmc-scenario-db.md) for the scenario schema, the
OCV/LVF derate model, and the signoff handoff seam.

POCV/SOCV with LVF Liberty, path-based STA, and any ML corner pruning are
**outside this open-flow evidence path** — they require commercial LVF Liberty
and a path-based signoff tool (PrimeTime SI / Tempus). The advanced-node section
below describes what that would require; it is BLOCKED on the commercial-EDA
gate.

## MVP (open PDKs): manifest-driven scenarios

The scenario set is the product of the manifest's PVT corners, RC corners and
modes. For the Sky130 manifest that is 3 PVT (TT/SS/FF) x 3 RC (nom/max/min)
x 1 mode (func) = 9 scenarios. The PVT operating points are read from
`pd/corner-manifests/sky130.yaml` (e.g. SS at 1.60 V / 100 C for worst setup,
FF at 1.95 V / -40 C for worst hold), not hardcoded in the driver.

Driver: `scripts/run_multi_corner_sta.py` calls OpenSTA (or OpenROAD's
internal STA engine) once per scenario. Outputs:

- `{scenario}.tcl` script that read_liberty / read_verilog / read_sdc /
  read_spef, applies the OCV (or LVF, when declared) derate, and runs
  report_checks.
- `{scenario}.rpt` four-line digest (setup/hold WNS + TNS).
- `multi_corner_sta.json` aggregate summary (`eliza.pd_multi_corner_sta.v1`),
  carrying the resolved Liberty/SPEF/SDC and the OCV model per scenario.

`report_checks` text can be normalized into the canonical
`eliza.pd_timing_path.v1` schema with
`scripts/normalize_timing_paths.py` for tool-agnostic path comparison.

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

- All scenarios in the node's scenario DB run to completion.
- The worst-setup scenario (SS in the Sky130 manifest) has setup_wns >= 0 OR
  the failing paths land in the architectural exception list under
  `pd/constraints/`.
- The worst-hold scenario (FF in the Sky130 manifest) has hold_wns >= 0.

## Advanced node (BLOCKED on commercial EDA)

At N3/N2 the multi-corner space is **fundamentally bigger**:

| Dimension | Sky130 | N3/N2 |
| --- | --- | --- |
| Process | 3 (SS/TT/FF) | 5+ (SS/SF/TT/FS/FF) |
| Voltage | 1 nominal +/- 10 % | 3-5 (NOM, OV, UV, ALV, retention) |
| Temperature | -40/25/125 | full mil + ambient self-heat |
| RC | 3 (nom/min/max) | 5+ (cworst/cbest/rcworst/rcbest/typ) |
| AOCV/POCV/SOCV | graph-based OCV derate | LVF Liberty + path-based OCV |
| Aging | none | EM/HCI/NBTI aging-aware re-spin |

The full Cartesian product is 100-200 corners. The industry approach is LVF
Liberty (statistical POCV/SOCV instead of worst-case + derate), path-based STA
on the violating paths, and corner pruning to keep the path-based pass
tractable. This open-flow evidence path excludes those features because they
require commercial LVF Liberty and a path-based signoff tool (PrimeTime SI /
Tempus).

This is **all** BLOCKED on the commercial-EDA gate
(`docs/evidence/pd/commercial-eda-gate.yaml`). The advanced-node corner
manifests declare `ocv_model: LVF_or_SOCV`; their scenario sets stay empty
until that gate unblocks (see [mmmc-scenario-db.md](mmmc-scenario-db.md)).

## Why exercise STA methodology now

The methodology-validation discipline matters:

- Driving multi-corner STA on Sky130 forces us to discover SDC bugs,
  exception leakage, and corner-skew bugs at a stage where one Liberty
  per corner is fast and free.
- The aggregate JSON schema (`eliza.pd_multi_corner_sta.v1`) is the same
  shape we will use at the advanced node. Only the corner count and the
  derate model change.

## What unblocks the multi-corner-sta-evidence gate

For Stage 1 (open PDK):

- A full release run produces a report for every scenario in the node DB.
- Every scenario has setup_wns >= 0 (or documented exception) and
  hold_wns >= 0.

For the advanced node:

- The commercial-EDA gate unblocks.
- A path-based signoff tool (PrimeTime SI / Tempus) runs the advanced-node
  scenario set against LVF Liberty.
- The handoff bundle round-trips: vendor reports import back into
  `eliza.pd_timing_path.v1` with provenance verified
  (`scripts/check_signoff_handoff.py --import-report`).
