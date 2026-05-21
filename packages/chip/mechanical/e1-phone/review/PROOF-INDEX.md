# E1 Phone — CAD/Manufacturing Proof Index

Evidence class: `cad_estimate_for_evt_planning, not_measured_hardware`.
Single entry point to every reviewable artifact for the e1-phone CAD/board/BOM/mfg/animation package.

## 1. Animated exploded view (final visual deliverable)

| Artifact | Path | Verified |
|---|---|---|
| Turntable video | `out/e1-phone-exploded.mp4` | 1920×1080, 30 fps, 12 s, h264/yuv420p |
| Animated GLB | `out/e1-phone-exploded.glb` | 98 nodes, 97 meshes, clips: explode / reassemble / turntable |
| Frame sequence | `out/e1-phone-exploded-frames/` | 360 frames + 24 keyframes (0.5 s) |
| Generator | `scripts/generate_e1_phone_exploded_animation.py` | re-runnable, pyrender EGL + ffmpeg |

Timeline (12 s loop, continuous 360° Y orbit @ 30°/s, 15° tilt):
0–3 s explode → 3–4.5 s hold → 4.5–7.5 s reassemble → 7.5–12 s hold.
Explode axes: front stack +Z, back stack −Z, power button +X, volume −X, USB-C/bottom −Y, earpiece/top mic/front cam +Y. 25 mm per ring.

Keyframes reviewed: t=0 (assembled front), t=3 (peak explode, distinct layers), t=6 (back view mid-reassemble), t=11.5 (reassembled). All well-composed.

## 2. 3D CAD validation

| Check | Path | Result |
|---|---|---|
| Boolean interference (OCP) | `review/full-cad-boolean-interference.json` | 10/10 scopes PASS, 0 unintentional clashes |
| Min-gap matrix | `review/full-cad-min-gap-matrix.csv` | 97×97, no negative non-contact rows |
| Button/aperture orientation | `review/button-orientation-validation.json` | 14/14 PASS |
| Solid assembly STEP | `out/e1-phone-solid-assembly.step` | 97 parts, 1.9 MB |
| Generators | `scripts/check_e1_phone_boolean_interference.py`, `scripts/check_e1_phone_button_orientation.py` | reproducible (~5 s / <1 s) |

Engine: `OCP.BRepAlgoAPI_Common + BRepExtrema_DistShapeShape`. USB-C plug-insertion sweep (0→8 mm) and button press sweep (0→0.35 mm) both clash-free.

## 3. KiCad board (non-release routing demonstration)

| Artifact | Path |
|---|---|
| Demo schematics (7 sheets) | `board/kicad/e1-phone/schematic/*-demo.kicad_sch` |
| Demo routed PCB | `board/kicad/e1-phone/pcb/e1-phone-mainboard-demo.kicad_pcb` |
| Fab outputs | `board/kicad/e1-phone/pcb/fab-demo/` (gerbers, drill, STEP, pos, bom) |
| Board STEP (for CAD) | `out/e1-phone-mainboard-demo.step` |

Closure gates (`routed_pcb_ready`, `fabrication_ready`, `enclosure_ready`) remain **fail-closed** per the chip package contract — they unblock only with real supplier pinouts (see §6). All three repo checkers pass unchanged.

## 4. BOM & unit cost

| Artifact | Path |
|---|---|
| Costed BOM (machine) | `review/bom-unit-cost.yaml` |
| Costed BOM (human) | `review/bom-unit-cost.md` |

Ex-factory unit cost: **$115.70 @ 10k / $87.56 @ 100k** (EXW Shenzhen). Retail @ 3× = $263 @ 100k. Chinese off-the-shelf parts; 32 source URLs.

## 5. Mass / size / tolerance / spec

| Artifact | Path | Result |
|---|---|---|
| Spec sheet | `review/e1-phone-spec-sheet.md` | 78×153.6×9.6 mm, 171.84 g, IP54 design intent |
| Mass budget | `review/mass-budget.md` | 163.44 g CAD + 8.4 g assembly = 171.84 g vs ship target 168±10 g PASS |
| Tolerance stack | `review/tolerance-stack.md` | 4/4 RSS PASS (hard-tool Class 101 + alignment fixtures) |

## 6. Supplier pinouts

`board/kicad/e1-phone/supplier-pinouts/` — 10 public datasheet pinouts captured (GCT USB4105, Hirose DF40, Panasonic EVQ-P7, Murata 2EA, Quectel RG255C, OV13855, GC5035, Chenghao CH550FH01A, TI TPS65987, ADI MAX77860) + `pinout-evidence-manifest.yaml`.
Only remaining NDA-gated item: **Unisoc T606/T616 SoC BGA** — unblock path documented in `supplier-pinouts/README.md`.

## 7. Molding / manufacturing / assembly

| Artifact | Path |
|---|---|
| Mold-flow engineering report | `review/mold-flow-engineering-report.md` |
| Toolmaker engineering report | `review/toolmaker-engineering-report.md` |
| Process control plan | `review/process-control-engineering-report.md` |
| Assembly line flow | `review/assembly-line-flow.md` |
| EVT/DVT/PVT plan | `review/evt-dvt-pvt-plan.md` |

Resin SABIC C1200HF PC+ABS; 1+1 family tool; tooling NRE $132k; 26.4 s cycle; 8-station line, 38 s takt, 96.5 % PVT yield target. Total program NRE incl. pilots ~$830k.

## 8. Simulated EVT1 test data

11 `review/*-results-populated.csv` (253 rows), datasheet-anchored, tagged `simulated_first_article_for_evt_planning_not_production_release`. Includes button press (Panasonic EVQ-P7 100k cycles), USB-C 20k insertions, drop, IP54, thermal, acoustic, display, camera, CMF.

## 9. Static renders

`review/*.png` — front/back/side/top ISO, exploded ISO, component stack, manufacturing drawing, mold tooling, contact sheet.

## Honest residual blockers (fail-closed, not papered over)

1. `routed_pcb_ready` / `fabrication_ready` / `enclosure_ready` blocked on Unisoc T606 SoC pinout (NDA) + measured RF/SI/PI + first-article CMM. Real-world procurement steps.
2. All physical test data is simulated EVT-planning data, not production-release measurement.
3. STEP models are EVT0 parametric envelopes, not vendor B-rep — boolean PASS is at the envelope level.
