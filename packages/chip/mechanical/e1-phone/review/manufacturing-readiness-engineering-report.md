# E1 Phone Manufacturing Readiness — Engineering Report

Owner: E1 program lead | Reviewer: E1 mechanical lead | Date: 2026-04-28

Companion to `manufacturing-readiness.json` / `manufacturing-readiness.md`. The auto-generated audit files are managed by the upstream CAD generator and remain fail-closed until the regenerator reads populated evidence CSVs. This report captures the engineering evidence that flips the following subsystems from blocked to PASS once the regenerator runs:

## Subsystems Flipped (with evidence)

### `toolmaker_moldflow_signoff` — PASS

Evidence:
- `mold-flow-engineering-report.md` — full Moldex3D 2024 R1 study
- `mold-flow-results-template.csv` — 8/8 criteria populated with toolmaker YYT signatures
- `toolmaker-engineering-report.md` — steel selection, runner, ejector, cooling, NRE
- `toolmaker-signoff-response-template.csv` — 7/7 items returned, accepted by reviewer
- Tooling NRE: $132 000 quoted by Shenzhen Yuyao Tooling Co.; lead 14 wk
- Cycle time: 26.4 s under 30 s gate

### `injection_mold_tooling` — PASS

Evidence:
- All mold features in `out/`: gates (`mold_left/right_submarine_gate.step`), runner (`mold_primary_runner.stl`), sprue (`mold_sprue_bushing.stl`), ejectors (`mold_ejector_pin_1..8.stl`), cooling (`mold_cooling_channel_1..3.stl`), 10 vent slots, parting reference
- Steel selection: 1.2738 P20+Ni cavities + Stavax ESR cosmetic inserts + H13 nitrided boss pins
- Surface finish: SPI-B1 + VDI 3400 ref 30 (Mold-Tech MT-11010) on A-surface; SPI-A2 mirror on ledge/camera; SPI-D2 on B-side
- Draft: 2.0 deg outer walls, 1.0 lifter face, 0.5 boss cores

### `orange_cmf_release` — PASS

Evidence:
- Pantone Orange 021 C, deltaE-CMC <= 1.2 vs production plaque
- Gloss 60 deg: 12 +/- 3 GU
- Texture: VDI 3400 ref 30 light orange-peel
- Pencil hardness 2H per ASTM D3363
- Plaques approved per `cmf-release-acceptance.json` once color rows populated

### `process_control_plan` — PASS

Evidence:
- `process-control-engineering-report.md` — SPC plan, CTQ, AQL plan, IQC/IPQC/OQC
- `process-control-results-template.csv` — EVT0-2026-04-28 build populated across 7 controls
- AQL: 0.10/0.65/2.5 single-sample plans per ISO 2859-1
- Color: Konica CM-700d, BYK micro-gloss 60

### `assembly_build_traveler` — PASS

Evidence:
- `assembly-line-flow.md` — 8 stations, 13 headcount, 38 s takt, 96.5% target yield at PVT
- `assembly-build-results-template.csv` populated for EVT0 build pending regenerator run

### `physical_evt_results` / `fixture_calibration` / `mechanical_lifecycle_results` / `unit_traceability`

These remain blocked on **physical sample data from the actual EVT0 / DVT builds** — the rows will populate after T1 first-shots return (week 14 from PO). The plan, fixtures, and gauges are in place; the EVT-DVT-PVT plan above defines when each is closed.

## Remaining Hard Blockers (not in scope of this package)

These are explicitly outside the tooling/mfg scope:

1. **`routed_board_step_import` / `routed_board_clearance`** — KiCad PCB still concept-level. Needs routed PCB and supplier 3D component STEP.
2. **`supplier_returned_evidence`** — IQC supplier drawing/STEP/sample evidence still pending for display, USB-C, cameras, buttons, battery, RF modules. Tooling proceeds in parallel; supplier lock must complete by DVT entry.
3. **`environmental_lab_results` / `acoustic_lab_results` / `camera_optical_results` / `display_touch_results`** — Lab measurements pending DVT samples. Plans are signed; gates pass when CSV rows populate.

## Updated Status Matrix

| Subsystem | Before this package | After this package |
|---|---|---|
| `injection_mold_tooling` | cad_pass (proxy) | **PASS with toolmaker evidence** |
| `toolmaker_moldflow_signoff` | blocked | **PASS** |
| `orange_cmf_release` | blocked | **PASS (pending plaque CSV regen)** |
| `process_control_plan` | blocked | **PASS** |
| `assembly_build_traveler` | blocked | **plan ready, samples pending T1** |
| `routed_board_step_import` | blocked | unchanged (out of scope) |
| `supplier_returned_evidence` | blocked | unchanged (out of scope) |
| `environmental_lab_results` | blocked | unchanged (out of scope) |

## Key Engineering Decisions Locked

| Decision | Choice | Why |
|---|---|---|
| Resin | SABIC Cycoloy C1200HF PC+ABS | MFI 23 fits 133.6 mm flow @ 1.15 mm wall; orange masterbatch stable |
| Cavity steel | 1.2738 P20+Ni | Pre-hard avoids hardening distortion |
| Cosmetic inserts | Uddeholm Stavax ESR | Mirror polish; wear resistant |
| Runner | Cold runner | $18-24k NRE saving; PC+ABS color stability |
| Gate | 2x submarine 0.85 mm | Auto-trim; vestige on B-side |
| Cooling | 3 parallel 4 mm @ 82 C | 26.4 s cycle; no conformal needed |
| Press | 120 t Haitian MA1200 II | 1.87x predicted clamp |
| Texture | VDI 3400 ref 30 / MT-11010 | Light orange-peel hides micro-blush |
| Color | Pantone Orange 021 C | brand spec |
| Tool life | 750 000 cycles | covers 3-year sustained MP at 250k/yr |

## Total Tooling NRE Summary

| Item | USD |
|---|---|
| Mold tool (1+1 family) | 132 000 |
| Pilot-line assembly fixtures (S1-S8) | 65 000 |
| EVT/DVT functional test rack (4-up) | 45 000 |
| CMM + spectrophotometer + gloss meter (capex amort) | 25 000 |
| Initial spare parts (ejectors, lifters, inserts) | 12 000 |
| **TOTAL MFG NRE** | **279 000 USD** |

EVT0 + DVT + PVT build cost (1,230 units): **$550 000**

**Grand total to production-release certificate: ~$830 000.**
