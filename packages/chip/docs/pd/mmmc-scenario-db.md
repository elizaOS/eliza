# MMMC Scenario DB and Signoff Handoff

This document describes the multi-mode multi-corner (MMMC) scenario database
and the commercial-EDA signoff handoff seam. Both are derived from, and
validated against, the corner manifests in `pd/corner-manifests/<node_id>.yaml`
(`eliza.pd_corner_manifest.v1`).

## Scenario DB — `eliza.pd_mmmc_scenario.v1`

`scripts/sta_scenario_db.py` turns a corner manifest into an analysis-view
set. A scenario is the product:

    scenario = delay_corner (PVT) x rc_corner x mode

- **delay_corner** comes from the manifest's `pvt_corners`; it references a
  Liberty file by basename and carries process/voltage/temperature/role.
- **rc_corner** comes from `rc_corners`; it references an extraction view.
- **mode** is the manifest's `modes` list, defaulting to `["func"]`. We do not
  invent scan/test modes a node does not declare.

The DB carries no Liberty/SPEF bytes — only references the STA driver resolves
against `PDK_ROOT` at run time. For the open and predictive manifests today
this yields 3 PVT x 3 RC x 1 mode = 9 scenarios.

```sh
python3 scripts/sta_scenario_db.py --node-id sky130 --out pd/signoff/scenarios/sky130.json
```

### Blocked (NDA) nodes

For `tsmc-n2p`, `tsmc-a14`, `intel-14a`, `samsung-sf2p` the manifest status is
`blocked_until_foundry_agreement` and ships no Liberty. The scenario set is
**present but empty** with `blocked: true` and a reason naming the foundry +
commercial-EDA gate. We never fabricate corners for these nodes. The committed
DBs under `pd/signoff/scenarios/` include these empty blocked sets so the seam
shape is reviewable without any NDA data.

### OCV / LVF derate model

Each scenario records an OCV model:

- **`ocv`** (default): documented graph-based early/late margin derates
  (`set_timing_derate -early 0.95 / -late 1.05`). These bound a single-Vt open
  PDK flow; they are **not** claimed to match silicon.
- **`lvf`**: emitted only when the manifest declares an LVF/SOCV `ocv_model`.
  The STA driver then emits `read_lvf <file>` when an LVF Liberty companion
  actually resolves under `PDK_ROOT`, plus the margin derates as a backstop.
  If no LVF file resolves, the run records `lvf_resolved: false` and falls back
  to the margin derates — it never fabricates statistical data.

The open Sky130/GF180/IHP PDKs do not publish LVF, so today every open
scenario uses the `ocv` model. The advanced-node manifests declare
`ocv_model: LVF_or_SOCV`; their scenario sets stay empty until unblocked.

## Multi-corner STA driver

`scripts/run_multi_corner_sta.py` consumes the scenario DB (built from the
corner manifest for `--node-id`, default `sky130`) and runs OpenSTA once per
scenario, emitting `eliza.pd_multi_corner_sta.v1`.

```sh
python3 scripts/run_multi_corner_sta.py \
    --run-dir pd/openlane/runs/<RUN_TAG> \
    --out-dir build/pd/multi_corner_sta/<RUN_TAG> \
    --pdk-root <sky130A install> \
    --node-id sky130
```

Override knobs:

- `--scenario-db <json>` — run a prebuilt scenario DB instead of rebuilding.
- `--corners-json <json>` — legacy `[{name,process,rc}]` list, mapped onto the
  node DB (backward compatible with the original six-corner driver).

Fail-closed: a missing Liberty/SPEF/SDC/netlist makes that scenario error and
the run exit non-zero. The driver never substitutes a different process
corner's Liberty and never fabricates timing numbers. A blocked node exits
non-zero with the block reason.

## Canonical timing paths — `eliza.pd_timing_path.v1`

`scripts/normalize_timing_paths.py` parses OpenSTA `report_checks` text into a
tool-agnostic path schema (startpoint, endpoint, path_group, path_type,
slack, met, arrival, required, per-stage pin/cell/edge/delay/time). This is the
schema the signoff import-back path also targets, so OpenSTA and a future
PrimeTime/Tempus run are directly comparable. Malformed report blocks are
dropped with a recorded warning — never assigned fabricated slack.

## Signoff handoff seam — `eliza.pd_signoff_handoff.v1`

These are seams, not engines. We do not run PrimeTime or Tempus.

`scripts/build_signoff_handoff.py` exports a handoff bundle: the gate netlist,
signoff SDC, per-RC-corner SPEF, the Liberty references per delay corner, and
the scenario DB. Every embedded local file is recorded with its sha256 so a
partner — and our own validator — can verify provenance.

```sh
python3 scripts/build_signoff_handoff.py \
    --node-id sky130 \
    --netlist <run>/final/nl/e1_chip_top.nl.v \
    --sdc pd/constraints/e1_soc.sdc \
    --spef <run>/final/spef/e1_chip_top.max.spef \
    --out pd/signoff/handoff/sky130.json
```

`scripts/check_signoff_handoff.py` validates the bundle (schema + every
referenced file present with matching sha256) and provides the import-back
path:

```sh
python3 scripts/check_signoff_handoff.py \
    --handoff pd/signoff/handoff/sky130.json \
    --import-report <vendor.rpt|vendor.json> \
    --source-tool primetime \
    --out build/pd/signoff/imported_paths.json
```

Import-back rules (enforced, fail-closed):

- **Provenance:** the vendor report must reference the bundle's top design
  (`e1_chip_top`); otherwise the import is rejected.
- **No fabrication:** a vendor record missing startpoint/endpoint/path_type/
  slack is dropped with a warning, never filled in.
- **Redaction-safe:** slack and path topology are kept; vendor cell internals
  are stripped — each stage keeps its pin and a coarse `cell_class` label, not
  the proprietary cell name.

A blocked (NDA) bundle is a valid empty bundle: the validator reports BLOCKED
(exit 2, distinct from a real failure) and import-back against it is rejected.
The committed bundles under `pd/signoff/handoff/` cover the four NDA nodes.

## Make targets

- `make sta-scenario-check` — build + validate the scenario DBs for all nodes.
- `make signoff-handoff-check` — validate the committed handoff bundles.
```
