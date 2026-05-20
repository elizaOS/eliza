# Physical-Design Implementation Path for E1 (2026-05-19)

This file ranks concrete physical-design recommendations for the Eliza E1
chip, tying each to:

- `docs/architecture-optimization/physical-power-thermal.md` - PD / IR-drop /
  thermal / DFT work order.
- `docs/three-week-prototype-workstreams.md` - the OpenLane Sky130 utilization
  incident (771.788% on the first full run) and the Volare PDK fix.
- `docs/spec-db/process-14a-effects.yaml` - the 14A `fail_closed`
  signoff gate for the 2028 target.

All recommendations stay inside the existing repo architecture: OpenLane 2
Docker, OpenROAD core, Sky130A + Volare PDK, the AlphaChip Docker pipeline,
and the evidence model enforced by
`pd/signoff/run-manifest.schema.json` + `scripts/check_pd_signoff.py`.

Recommendations are ranked by confidence and expected impact. High-confidence
items belong in the next PD work order. Medium-confidence items belong in
follow-up workstreams. Low-confidence items require explicit product /
architecture decisions before they can land.

## High-confidence recommendations

### H1. Tighten OpenROAD `repair_timing` / `repair_design` budget

Evidence: 2026-05-19 release run records 23,099 max slew violations, 442
max capacitance violations, and a -0.109 ns worst hold slack (see
`research/alpha_chip_macro_placement/06_e1_notes/openlane_full_release_2026-05-19.md`).

Action:
- Raise `DESIGN_REPAIR_MAX_SLEW_PCT` and `DESIGN_REPAIR_MAX_CAP_PCT` from 0
  to non-zero margins in `pd/openlane/config.sky130.json` so repair has
  room to insert buffers.
- Consider lengthening `DESIGN_REPAIR_MAX_WIRE_LENGTH` past 300 if slew
  hotspots are concentrated on long nets.
- Re-run the release flow and confirm the violation count drops without
  inflating area beyond the current 0.265 utilization.

This is a pure config tune. No new tool. No new dependency.

### H2. Add OpenROAD PSM static IR-drop to the signoff loop

Evidence: `physical-power-thermal.md` requires IR-drop, EM, PDN impedance,
rail current, and decoupling evidence; the live flow does not yet produce
it.

Action:
- Enable PSM as a final step in the OpenLane 2 Sky130 flow.
- Emit a `psm_ir_drop.rpt` and per-instance worst-drop table into
  `pd/openlane/runs/<run>/final/`.
- Extend `pd/signoff/run-manifest.schema.json` and
  `scripts/check_pd_signoff.py` to require the PSM artifact for green
  signoff.

This closes the most-cited gap in `physical-power-thermal.md` with one
tool that is already in the OpenROAD codebase.

### H3. Make PDN topology explicit in the config

Evidence: pdngen currently runs with implicit defaults. There is no
auditable PDN topology record per run.

Action:
- Add a parameterized PDN configuration block to
  `pd/openlane/config.sky130.json` (ring widths, strap widths, layer
  assignment, pitch).
- Record pdngen output (per-run JSON or text) in
  `pd/openlane/runs/<run>/final/pdn/`.
- Add it to the signoff schema.

### H4. Pin and record tool digests per run

Evidence: `docs/three-week-prototype-workstreams.md` already calls out
"record image digests/checksums for OpenLane, OSS CAD Suite, PDK archives,
and any forked tool refs."

Action:
- Compute SHA256 of the OpenLane 2 Docker image used for each run; record
  it in the run manifest.
- Compute and record SHA256 of:
  - the Volare PDK snapshot,
  - KLayout / Magic / Netgen / OpenROAD / Yosys / ABC binaries in the
    container,
  - the antenna deck used.
- Extend `pd/signoff/run-manifest.schema.json` so these digests are required
  fields, not optional.

### H5. Resolve the historical 771.788% utilization incident as a permanent regression gate

Evidence: `docs/three-week-prototype-workstreams.md` shows the original
PDK/OpenLane container mismatch produced 771.788% utilization; the Volare
revision fixed it.

Action:
- Add a regression gate in `scripts/check_pd_signoff.py` (or its sibling
  in `scripts/`) that fails if any future run reports a utilization above a
  configurable threshold (for example, 1.05). This converts the historical
  near-miss into a permanent fail-closed check.

## Medium-confidence recommendations

### M1. Add a second open flow for cross-validation

Evidence: `OpenROAD-flow-scripts` exists, supports NanGate45 and IHP130,
and is independent of the OpenLane 2 Python wrapper. The current E1 flow is
single-flow on Sky130.

Action:
- Run the E1 top through OpenROAD-flow-scripts on NanGate45 as an
  informational baseline. Compare wirelength, timing, congestion, and DRC
  count.
- Treat output as informational only. Do not change the Sky130 signoff
  path.

### M2. Wire AutoDMP as a faster macro-placement alternative

Evidence: `02_analysis/ai_driven_pd.md` ranks AutoDMP as the second-most-
ready ML macro-placement path after OpenROAD's built-in, ahead of AlphaChip
for the current macro-free E1 design.

Action:
- Add AutoDMP to `external/` alongside `circuit_training` and
  `MacroPlacement`.
- Run it on the E1 placement input once real hard macros exist.
- Compare AutoDMP, AlphaChip, and OpenROAD macro placement using the same
  validation pipeline already described in
  `research/alpha_chip_macro_placement/00_index.md` step 8.

### M3. Add CircuitNet 2.0 pretrained congestion / IR-drop predictors as informational gates

Evidence: `02_analysis/ai_driven_pd.md` section 3.

Action:
- Run CircuitNet 2.0's pretrained congestion predictor on the post-place
  DEF; record output as `pd_ml_congestion.json`.
- Run PowerNet (or CircuitNet's IR-drop variant) on the same DEF; record
  output as `pd_ml_ir_drop.json`.
- Declare both as informational only in the signoff schema. They never
  block.

### M4. HotSpot block-level thermal model

Evidence: `physical-power-thermal.md` thermal section + the current
modeled-only posture of `soc-optimized-operating-point.yaml`.

Action:
- Generate a per-block power map from the OpenROAD report_power output for
  the 2026-05-19 release run.
- Run HotSpot with a basic Sky130 package + standard FR4 board model.
- Record `hotspot_thermal.rpt` as planning evidence (consistent with the
  existing modeled posture).
- Do not claim signoff-grade thermal evidence at this stage.

### M5. Insert KLayout XOR / DRC concurrency

Evidence: `pd/openlane/config.sky130.json` sets
`KLAYOUT_XOR_THREADS: 1` and `KLAYOUT_DRC_THREADS: 1`.

Action:
- If the CI container has multi-core budget, raise both to match the worker
  CPU count. The 2026-05-19 release already runs `DRT_THREADS: 4`, so the
  precedent for non-1 thread counts exists in this flow.

## Low-confidence recommendations (require product / architecture decision)

### L1. Move toward a parameterized soft-macro clustering pass

Evidence: `openlane_full_release_2026-05-19.md` records 0 hard macros. The
follow-up section says "Add real hard macros or a more intentional
clustering pass before treating AlphaChip results as tapeout-relevant
floorplanning."

Action (deferred):
- Decide whether E1 wants to introduce hard SRAM/cache/NPU macros for the
  Sky130 PD smoke, or to use a clustering pass to generate soft macros.
- If clustering, define the cluster contract before implementing.

### L2. Add UPF (IEEE 1801) power-intent file

Evidence: E1 currently has a single power domain. UPF only becomes useful
once multiple voltage islands exist (for example, an always-on island for
the camera/microphone front-end on a future variant).

Action (deferred):
- Revisit when the SoC partitioning grows past one supply.

### L3. Move HLS into the toolchain

Evidence: HLS tools surveyed in `02_analysis/open_eda_flow_state_of_the_art.md`
section 11 (Bambu, Dynamatic, ScaleHLS, Calyx).

Action (deferred):
- HLS belongs to the compiler/runtime side. PD packet does not own this
  decision. Recorded here so the option is not lost.

### L4. 14A signoff path

Evidence: `docs/spec-db/process-14a-effects.yaml` declares
`status: fail_closed_process_work_order`.

Action: do nothing in this packet. The 14A signoff path requires foundry
PDK selection and is correctly gated by the existing
`process_14a_effects_check` and `pd_signoff_release_check` gates.

## Cross-reference summary

| Recommendation | Tied to |
| --- | --- |
| H1 (timing repair) | `docs/architecture-optimization/physical-power-thermal.md` |
| H2 (PSM IR-drop) | `physical-power-thermal.md`, `pd/signoff/run-manifest.schema.json` |
| H3 (PDN explicit) | `physical-power-thermal.md`, `pd/signoff/run-manifest.schema.json` |
| H4 (tool digests) | `docs/three-week-prototype-workstreams.md` |
| H5 (utilization gate) | `docs/three-week-prototype-workstreams.md` |
| M1 (second flow) | `02_analysis/open_eda_flow_state_of_the_art.md` |
| M2 (AutoDMP) | `02_analysis/ai_driven_pd.md`, `research/alpha_chip_macro_placement/00_index.md` |
| M3 (ML predictors) | `02_analysis/ai_driven_pd.md` |
| M4 (HotSpot thermal) | `physical-power-thermal.md`, `docs/architecture-optimization/soc-optimized-operating-point.yaml` |
| M5 (KLayout threads) | `pd/openlane/config.sky130.json` |
| L1 (soft macros) | `research/alpha_chip_macro_placement/06_e1_notes/openlane_full_release_2026-05-19.md` |
| L4 (14A gate) | `docs/spec-db/process-14a-effects.yaml` |

## What this packet is not

- This is a research and planning packet. It does not modify
  `pd/openlane/config.sky130.json`, the OpenLane runs, the signoff schema,
  `scripts/check_pd_signoff.py`, or any other live PD artifact.
- The recommendations above are the input to the next PD work order. They
  are not themselves the work order.
