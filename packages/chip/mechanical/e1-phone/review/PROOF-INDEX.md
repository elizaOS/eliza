# E1 Phone — CAD/Manufacturing Proof Index

Evidence class: `cad_estimate_for_evt_planning, not_measured_hardware`.
Single entry point to every reviewable artifact for the e1-phone CAD/board/BOM/mfg/animation package.

## 0. Flush-back design rev (current fail-closed snapshot)

Revision `evt0-mechanical-cad-bonded-display-thinned` (authoritative; matches `cad/e1_phone_params.yaml` and the regenerated proofs). The earlier `evt0-mechanical-cad-swell-camera-seal` rev (12.7 mm) was thinned to 11.8 mm in the bonded-display rev: the 2.8 mm front air band was a missing-detail modeling artifact (only the bare 1.7 mm TFT cell was placed instead of the full 3.39 mm bonded LCD+CTP module). Modeling the bonded module under the cover glass closed the false gap and the reclaimed depth was removed from the device while holding the flush back, the 0.6 mm battery-swell void, and the 0.4 mm rear-camera burial. See `design-change-flush-back.md` (Thickness-optimization + void rev).

- Device **78 × 153.6 × 11.8 mm** (flush back, no bump; bonded display closes the false front air gap, depth holds the camera burial + battery-swell void).
- Battery **64 × 87 × 5.6 mm = 5727 mAh / 22.05 Wh** + **0.6 mm swell void** on the back face (never pushes display); 0.15 mm static gap to display.
- **Single lens** rear + front. Rear camera buried **0.40 mm**; flash buried **0.15 mm**.
- **Torch**: OSRAM CEYW-class flash LED + Awinic AW36515 driver, flush window, 6.6 mm from camera with opaque `rear_flash_camera_septum` baffle.
- **Cellular aperture tuner** (Qorvo QPC1252Q) added — closes the low-band (700–960 MHz) coverage via band-switching.
- **Drop-hardened**: cover glass 0.3 mm rim inset + PORON perimeter cushion (SF 1.10→1.93); screw bosses 6→10 + corner gussets + compliant battery foam shelf (corner SF 0.78→2.11).
- Buttons **standardized**: single SKU XKB TS-1187A-B-A-B (LCSC C318884), EVQ-P7A01P alt; travel 0.20 mm.
- **Compute**: Firefly Core-3566JD4 RK3566 SoM (public 260-pin pinout) — buildable from public data; bare-SoC cost-down path retained. **Zero NDA-gated lines.**
- Unit cost **$93.03 @100k (SoM) / $88.48 (bare-SoC)**; current generated CAD mass estimate **182.02 g**. This is **over the 168±10 g ship target** (158–178 g window) by 4.02 g. The CAD figure is a nominal-density estimate, not measured hardware; the overage is an open EVT mass-reduction / measured-mass action, not a closed gate. See `e1-phone-spec-sheet.md` and `mass-budget.md`.

Residual sweep:
| Residual | Result | Evidence |
|---|---|---|
| Parametric boolean clash | 0 unintentional, 11/11 envelope scopes PASS, flush-back 0.0 mm | `check_e1_phone_boolean_interference.py` |
| Supplier-B-rep boolean release gate | fail-closed: blocked scopes await supplier B-rep + routed STEP | `full-cad-boolean-interference.json` |
| Button orientation | 15/15 features + 2/2 coaxiality PASS | `button-orientation-validation.json` |
| Assembly | 19 steps; trapped-part status is tracked by the current assembly verifier and remains non-release evidence | `assembly-verification.md` |
| Button physics | 6/6 PASS (0.20 mm travel) | `button-physics-sim.md` |
| Battery swell | 0.6 mm void, no display load | `design-change-flush-back.md` |
| Camera fit | buried 0.40 mm | boolean burial check |
| USB-C↔speaker seal | 1.1 mm wall (≥1.0) | `design-change-flush-back.md` |
| ERC (demo) | 0 errors / 0 warnings (kicad-cli 9.0.9) | `board/.../erc/erc-closure.md` |
| RF/SI/PI | SI+PI PASS; cellular all bands PASS w/ tuner | `rf-si-pi-simulation.md` |
| Drop (1.0 m) | glass SF 1.93, boss SF 2.11, survives | `drop-acoustic-simulation.md` |
| Acoustics | speaker 88 dB, earpiece 108 dB, mic 65 dBA SNR; leak 2.39 dB | `drop-acoustic-simulation.md` |
| Compute NDA | RETIRED via RK3566 SoM | `compute-sourcing-resolution.md` |
| Components (9) | all manufacturable/purchasable | `component-review-*.md` |

## 1. Animated exploded view (final visual deliverable)

| Artifact | Path | Verified |
|---|---|---|
| Turntable video | `out/e1-phone-exploded.mp4` | 1920×1080, 30 fps, 12 s, h264/yuv420p |
| Animated GLB | `out/e1-phone-exploded.glb` | 96 nodes, 95 meshes, clips: explode / reassemble / turntable |
| Frame sequence | `out/e1-phone-exploded-frames/` | 360 frames + 24 keyframes (0.5 s); flush back confirmed at t=6 |
| Generator | `scripts/generate_e1_phone_exploded_animation.py` | re-runnable, pyrender EGL + ffmpeg |

Timeline (12 s loop, continuous 360° Y orbit @ 30°/s, 15° tilt):
0–3 s explode → 3–4.5 s hold → 4.5–7.5 s reassemble → 7.5–12 s hold.
Explode axes: front stack +Z, back stack −Z, power button +X, volume −X, USB-C/bottom −Y, earpiece/top mic/front cam +Y. 25 mm per ring.

Keyframes reviewed: t=0 (assembled front), t=3 (peak explode, distinct layers), t=6 (back view mid-reassemble), t=11.5 (reassembled). All well-composed.

## 2. 3D CAD validation

| Check | Path | Result |
|---|---|---|
| Parametric boolean interference (OCP) | `scripts/check_e1_phone_boolean_interference.py` | 11/11 envelope scopes PASS, 0 unintentional clashes, flush-back 0.0 mm |
| Supplier-B-rep boolean release gate | `review/full-cad-boolean-interference.json` | local concept envelope PASS: 11/11 scopes, 0 unintentional clashes; release remains blocked pending supplier B-rep + routed STEP |
| Min-gap matrix | `review/full-cad-min-gap-matrix.csv` | full assembly, no negative non-contact rows |
| Button/aperture orientation | `review/button-orientation-validation.json` | 15/15 features + 2/2 coaxiality PASS |
| Solid assembly STEP | `out/e1-phone-solid-assembly.step` | 222-part concept assembly; STEP re-import validation passes for all 222 local envelope parts |
| Generators | `scripts/check_e1_phone_boolean_interference.py`, `scripts/check_e1_phone_button_orientation.py` | reproducible (~11 s / <1 s) |

Engine: `OCP.BRepAlgoAPI_Common + BRepExtrema_DistShapeShape`. USB-C plug-insertion sweep (0→8 mm) and button press sweep (0→0.20 mm) both clash-free.

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

Ex-factory unit cost (PATH A — SoM, buildable from public data): **$123.90 @ 10k / $93.03 @ 100k** (EXW Shenzhen). PATH B (bare SoC, NDA cost-down): $116.80 @ 10k / $88.48 @ 100k. Chinese off-the-shelf parts; source URLs in the costed BOM.

## 5. Mass / size / tolerance / spec

| Artifact | Path | Result |
|---|---|---|
| Spec sheet | `review/e1-phone-spec-sheet.md` | 78×153.6×11.8 mm, 182.02 g generated CAD estimate, IP54 design intent |
| Mass budget | `review/mass-budget.md` | 182.02 g vs ship target 168±10 g (158–178 g) — **FAIL, over by 4.02 g** (nominal-density estimate; open EVT mass-reduction action) |
| Tolerance stack | `review/tolerance-stack.md` | `cad_tolerance_stack_pass` (hard-tool Class 101 + alignment fixtures) |

## 6. Supplier pinouts

`board/kicad/e1-phone/supplier-pinouts/` — 11 public pinouts captured (Firefly Core-3566JD4 RK3566 compute SoM, GCT USB4105, Hirose DF40, Panasonic EVQ-P7, Murata 2EA, Quectel RG255C, OV13855, GC5035, Chenghao CH550FH01A, TI TPS65987, ADI MAX77860) + `pinout-evidence-manifest.yaml`.
**Compute NDA blocker RETIRED:** the former sole NDA-gated item (bare Unisoc T606/T616 SoC BGA) is resolved by sourcing compute as the Firefly Core-3566JD4 RK3566 SoM with a public 260-pin SODIMM connector pinout (`compute-som-pinout.yaml`). **Zero NDA-gated lines remain.** The bare-SoC + NDA route is retained as an optional cost-down — see `review/compute-sourcing-resolution.md` and `supplier-pinouts/README.md`.

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

## Remaining gap to production

The current CAD package is useful EVT0 planning evidence, but production remains fail-closed. The remaining work includes both physical confirmation and unresolved release inputs:

1. The analytical/sim results (RF efficiency, SI/PI, drop SF, acoustic SPL, button physics, tolerances) must be **confirmed by measurement** — anechoic chamber TRP/TIS, VNA S-params + TDR, scope eye, drop tower, B&K mic/Klippel, CMM first-article. The sims tell us *what to expect* and flag nothing failing; the lab confirms.
2. STEP models are EVT0 parametric envelopes, not vendor B-rep — boolean PASS is at the envelope level; supplier 3D models replace them at DVT.
3. `routed_pcb_ready` / `fabrication_ready` / `enclosure_ready` stay fail-closed in the repo contract until a routed production PCB, approved routed STEP, supplier B-rep, measured clearance, and release approvals land. The local candidate board/STEP proves workflow only, not tape-out readiness.
4. Supplier response packs, first-article fit data, factory outputs, and signed approvals are still absent and must not be inferred from local generated artifacts.
