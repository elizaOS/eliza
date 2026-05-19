# PDN, IR-Drop, EM, and Thermal: Open-Source Tooling and Gaps

This file enumerates the open tools available for PDN generation, IR-drop
analysis, EM analysis, antenna analysis, and thermal modeling, and maps
them to the E1 work order in
`docs/architecture-optimization/physical-power-thermal.md`.

References live in `01_sources/source_inventory.yaml`.

## 1. PDN generation

Tool: OpenROAD `pdngen` (`openroad_pdngen_docs`).

Status for E1:
- `pdngen` is invoked automatically inside OpenLane 2 during floorplanning.
- The E1 config does not currently override the default PDN topology; the
  generated PDN is the default Sky130 power-strap pattern.

What good evidence looks like:
- PDN topology recorded in the run's `final/` directory: ring and strap
  widths, layer assignment, pitch, density.
- A pdngen log archived alongside the run manifest declared in
  `pd/signoff/run-manifest.schema.json`.

Improvement path:
- For E1, the next step is parameterizing the PDN configuration so that the
  PDN topology is explicit in the config rather than implicit in the
  defaults. This is a small change with high signoff-evidence value.

## 2. Static IR-drop signoff

Tool: OpenROAD PSM (`openroad_psm_docs`). Tool reference paper:
`voltus_alternative_2024_paper`.

Status for E1:
- The current E1 OpenLane Sky130 config does not yet run PSM as part of the
  signoff loop.
- The work order in `physical-power-thermal.md` explicitly calls out IR
  drop, EM, PDN impedance, rail current, and decoupling as evidence
  requirements tied to workload, voltage corner, package, board, and PMIC.

Recommended action:
- Add PSM to the OpenLane 2 flow as a post-route signoff step.
- Bind PSM output to `pd/signoff/run-manifest.schema.json` so the IR-drop
  artifact is mandatory for a green signoff.

## 3. Dynamic IR-drop (workload-aware)

Open ML alternative: PowerNet (`powernet_paper`).

Status for E1:
- Not in use.
- For first silicon on Sky130, PSM-only static IR-drop is sufficient as a
  smoke gate. Dynamic IR-drop becomes important when E1's activity vectors
  for representative workloads exist.

Recommended action:
- Treat dynamic IR-drop as a P2 item (post first-silicon-evidence).
- When workload vectors land, evaluate PowerNet as an informational
  predictor running over the same DEF + activity data used by PSM.

## 4. Electromigration

OpenROAD PSM has limited EM analysis primarily targeting power straps. For
deeper EM signoff:

- Sky130 stack design rules cover EM limits per layer at given temperatures
  (referenced in `sky130_antenna_doc` and the broader Sky130 docs).
- The open-source EM signoff story is weaker than IR-drop. For Sky130 PD
  smoke, the right approach is:
  1. Configure pdngen so strap widths are conservative relative to the
     Sky130 EM limit at the modeled junction temperature.
  2. Verify max current density per layer using the static PSM output.
  3. Treat the result as informational, not a signoff guarantee.

For 14A / advanced-node EM signoff, foundry tools are required. The 14A
gate `process-14a-effects.yaml` already reflects this.

## 5. Antenna analysis

Tools:
- OpenROAD antenna checker (inside the antenna_repair step).
- Magic antenna deck (`magic_repo`).
- Sky130 antenna rule doc (`sky130_antenna_doc`).

Status for E1:
- The OpenLane Sky130 config enables `RUN_HEURISTIC_DIODE_INSERTION: true`
  and sets `GRT_ANTENNA_ITERS: 40`, `GRT_ANT_ITERS: 40`,
  `GRT_ANTENNA_MARGIN: 80`. These are robust defaults.
- `docs/pd/antenna-metadata.json` already records antenna metadata for the
  current run.

Recommended action:
- Keep the existing antenna posture for Sky130 work. No change required.
- Re-evaluate antenna parameters when the PDK changes.

## 6. Thermal modeling

Tools:
- HotSpot (`hotspot_thermal_repo`) - block-level thermal simulator.
- 3D-ICE (`3d_ice_repo`) - compact thermal modeling for stacked dies.

Status for E1:
- Neither is currently wired in.
- The `physical-power-thermal.md` work order requires post-route power +
  package model + board model + enclosure model + battery/PMIC losses + a
  modeled die temperature `<= 95 C` across required 14A corners, with
  signoff artifacts replacing the model.

Recommended action:
- For Sky130 PD smoke: HotSpot is sufficient to produce a first thermal
  model from OpenROAD-derived per-instance power and a chip floorplan.
  Output is planning evidence, consistent with the existing
  `soc-optimized-operating-point.yaml` posture.
- For the 14A target: nothing in the open thermal tools chain can produce
  signoff-quality thermal evidence at 1.4 nm class. The 14A gate already
  blocks claims here.

## 7. DRC and LVS gates

Tools: KLayout DRC (`klayout_drc_sky130`), Magic (`magic_repo`), Netgen
(`netgen_repo`).

Status for E1:
- All three are live in the existing OpenLane Sky130 flow.
- `QUIT_ON_MAGIC_DRC: true` and `QUIT_ON_LVS_ERROR: true` are correctly set.
- The 2026-05-19 release run reports zero errors across all three.

Recommended action:
- None. Posture is correct.

## 8. Combined signoff manifest

`pd/signoff/run-manifest.schema.json` and `scripts/check_pd_signoff.py` are
the right anchor. What is missing today:

1. PSM IR-drop artifact reference per run.
2. Explicit PDN topology record per run.
3. Tool digests (OpenLane, OpenROAD, Yosys, ABC, KLayout, Magic, Netgen,
   Volare PDK snapshot) per run.
4. Optional: ML predictor output declared as informational (never
   blocking).

All four are configuration/scripting tasks, not new tool research.

## 9. Bottom line

The open-source PD / signoff stack covers DRC, LVS, antenna, static
IR-drop, and synthesis/place/route for E1's Sky130 phase. The largest
near-term win is adding OpenROAD PSM to the signoff loop and making PDN
topology explicit in the config. The largest near-term gap is 14A signoff,
which no open tool can solve.
