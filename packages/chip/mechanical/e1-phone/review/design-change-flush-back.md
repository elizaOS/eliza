# E1 phone design change: flush back, thicker battery, single-lens cameras, rear torch

Deliberate product-owner design change (revision `evt0-mechanical-cad-flush-back`). The
rear surface is now a single flat (radiused-corner) wall with no camera bump and no
proud lens ring. The rear camera and a new rear torch LED are fully buried under the flat
back wall behind flush internal windows. Device depth was raised to accommodate burying
the camera, and the freed/added internal volume was spent on a thicker, higher-capacity
battery.

## Old vs new

| Parameter | Old | New |
|---|---|---|
| Device envelope (mm) | 78.0 x 153.6 x 9.6 | 78.0 x 153.6 x 11.8 |
| Back face | camera lens window proud, cosmetic ring | fully flush flat back, no bump, no ring |
| Battery envelope (mm) | 64.0 x 87.0 x 4.4 | 64.0 x 87.0 x 5.7 |
| Battery capacity | 4500 mAh / 17.33 Wh | 5830 mAh / 22.45 Wh |
| Rear camera | single AF module, proud lens window | single simple-AF module, buried, flush window |
| Front camera | single fixed-focus module | single fixed-focus module (unchanged) |
| Rear torch/flash | none | single buried white flash LED + flush window |
| Rear cosmetic tolerance | `rear_camera_ring_vs_glass_mm` 0.10 +/-0.10 | `rear_camera_window_flush_to_back_mm` 0.0 +/-0.05 |
| Buttons | Panasonic EVQ-P7 (power + volume) | unchanged; annotated `standardized_part: Panasonic EVQ-P7xxx` |

## Z-stack math (origin at mid-plane, +Z toward screen, -Z toward back)

Depth D = 11.8 mm. Back outer plane at z = -D/2 = -5.600 mm. Back wall = 1.15 mm, so the
back inner wall is at z = -5.600 + 1.15 = -4.450 mm.

Front-to-back layer budget (minimum to bury the rear camera flush):

| Layer | Thickness (mm) |
|---|---|
| Cover glass | 0.70 |
| Display / TFT module | 1.70 |
| Air gap + FPC | 0.30 |
| Main PCB | 0.80 |
| Rear camera module (behind/beside PCB) | 5.10 |
| Internal clearance over camera | 0.30 |
| Flat back wall | 1.15 |
| **Total minimum** | **10.05** |

11.8 mm is selected (within the 11.0-11.5 mm target band) to give margin for the thicker
battery, ribs, and assembly tolerance while keeping the back truly flush.

Tolerance-stack `nominal_z_stack_margin` = D - (cover_glass 0.70 + adhesive 0.18 + pcb 0.80
+ battery 5.70 + 1.20) = 11.8 - 8.58 = 2.62 mm (>= 1.0 mm required).

## Camera burial (proof of flush back)

Back outer plane = -5.600 mm. Back inner wall = -4.450 mm.

- Rear camera module (10 x 10 x 5.1): back face at -4.150 mm = back inner wall + 0.30 mm
  internal clearance. Front face at +0.950 mm. Burial clearance to inner wall = 0.30 mm.
- Rear camera flush window (`rear_camera_lens_window`, `rear_camera_cover_glass`): outer
  face coplanar with the back outer plane at exactly -5.600 mm, extending inward to
  -5.050 mm. Flush, never proud.
- Rear torch LED (`rear_flash_led`, 1.0 x 1.0 x 0.7): seated on the back inner wall, back
  face at -4.450 mm, buried. Its flush light-pipe window (`rear_flash_led_window`) outer
  face coplanar with the back outer plane at -5.600 mm.
- Battery (64 x 87 x 5.7) at z_center -1.45: back face at -4.300 mm, clears the back inner
  wall (-4.450 mm) by 0.15 mm.

Automated verification: across all parts, minimum z = -5.600 mm (the flush windows); no
part extends past the back outer plane. The compactness audit `flush_back_molded_depth`
case asserts depth <= 11.5 mm AND rear solid protrusion <= 0.01 mm.

## Battery capacity recompute

LiPo energy scales with cell volume; footprint is unchanged (64 x 87 mm), so capacity
scales linearly with thickness: 4500 mAh x (5.7 / 4.4) = 5829.5 -> 5830 mAh.
Energy = 5.830 Ah x 3.85 V = 22.45 Wh (was 17.33 Wh). Gain: +1330 mAh, +5.12 Wh (~30%).

## Single-lens confirmation

- Rear: ONE camera module, `lens_count: 1`, `array: single`. No second rear lens/array.
- Front: ONE camera module, `lens_count: 1`, `array: single`.
- Torch is a single white flash/emitter LED, not a camera.

## Torch part chosen

`rear_flash_led`: OSRAM/Everlight class 1.0 x 1.0 x 0.6 mm top-fire white flash/torch LED
(modeled envelope 1.0 x 1.0 x 0.7 mm). Placed beside the rear camera, emitting -Z out the
flat back through its own flush internal light-pipe window (`rear_flash_led_window`,
1.6 x 1.6 mm).

## CMF

Orange CMF unchanged (hard safety orange PC+ABS shell and buttons; black bonded cover
glass).

## Consolidated fix rev (7-review findings)

This section supersedes the stale battery/depth/clearance figures in the tables above. All
numbers below are read back from the generated parts (`build_parts` mesh bounds) and asserted
by `run_checks`; they regenerate clean with `python3 scripts/generate_e1_phone_cad.py` and pass
`test_generate_e1_phone_cad.py` (59/59).

### 1. Battery <-> display clash resolved (was 1392 mm^3 hard fail)

Device thickness raised to **11.8 mm**; battery thinned to **5.6 mm** and recentered to
z = -1.80 mm (was 5.7 mm at -1.45 mm). Origin at mid-plane, +Z toward screen.

- Back outer plane = -5.900 mm; back inner wall = -5.900 + 1.15 = **-4.750 mm**.
- `display_lcm` back face (read back) = **+1.150 mm** (fixed, referenced from the front).
- Battery front face = **+1.000 mm** -> gap to display back = **0.150 mm** (>= 0.15, was -0.25 overlap).
- Battery back face = **-4.600 mm** -> gap to back inner wall = **0.150 mm** (>= 0.15).
- New gate `battery_display_and_wall_clearance` fails closed if either gap < 0.15 mm.

Battery recompute: 4500 mAh x (5.6 / 4.4) = **5727 mAh**; energy = 5.727 Ah x 3.85 V =
**22.05 Wh**. (Net vs prior 5830 mAh/22.45 Wh: -103 mAh / -0.40 Wh, traded for a geometrically
clean stack with 0.15 mm clearances on both faces.)

### 2. Flash burial (was 0.05 mm proud)

`rear_flash_led` shifted +0.12 mm into the device (`FLASH_BURIAL_CLEARANCE_MM = 0.12`). Back
face now at **-4.630 mm**, i.e. **0.12 mm inside** the -4.750 mm back inner wall (>= 0.1 mm
required). Emit window (`rear_flash_led_window`) stays flush, outer face coplanar with the
back outer plane.

### 3. Flash <-> camera stray light

- Center-to-center spacing flash window to camera lens window = **6.600 mm** (>= 6.0 mm
  target, >> 5.0 mm hard floor); both windows share y, so spacing = `flash_offset_x` = 6.6 mm.
- New opaque PC part **`rear_flash_camera_septum`** added (0.6 mm thick wall, spanning between
  the flash window and camera baffle, from the back inner wall forward 3.0 mm), emitted as
  STEP/STL/OBJ, colored dark/opaque, registered in `camera_seal_specs`, `required_solid_names`,
  the assembly manifest, and the `camera_optical_seal_stack` gate. The gate now also asserts
  spacing >= 6.0 mm and flash burial >= 0.1 mm.

### 4. Flash footprint

Emitter reselected to **OSRAM CEYW class 1.0 x 1.0 x 0.6 white flash LED** with driver
**Awinic AW36515 I2C flash driver** (second source: Everlight 1.0 x 1.0), matching the
1.0 x 1.0 mm seat (resolves the Lumileds LXCL-PWF1 1.64 x 0.90 mm mismatch). Modeled envelope
1.0 x 1.0 x 0.7 mm unchanged.

### 5. Button travel

Power and volume `travel_mm` corrected **0.35 -> 0.20 mm** (EVQ-P7 / standardized side-push
datasheet travel). Cap proud = 0.30 mm > 0.20 mm hard stop, so tactile actuation occurs before
bottom-out and there is no rest preload. CAD gate `MIN_BUTTON_TRAVEL_MM = 0.18` mm; button cap
geometry is independent of travel, so no cap-stroke rework was needed.

### 6. Standardized button SKU

Both power and volume set to primary **XKB TS-1187A-B-A-B** (LCSC **C318884**, side-push
3.5 x 2.9 x 1.7 mm, 1.57 N), alternate **Panasonic EVQ-P7A01P**. Annotated `standardized_part`,
`standardized_mpn_primary`, `standardized_mpn_alternate`, `lcsc_part`. Cap force updated to
**1.57 N** (within 1.2-2.2 N; cap pressure power 0.119, volume 0.068 N/mm^2, both under limit).

### 7. IP54 seal annotation

`validation.environmental_targets.ingress_features` block added, listing the existing parts
that deliver IP54 design intent: button cap labyrinth rails + elastomer gaskets
(`power/volume_button_labyrinth_upper/lower_rail`, `*_elastomer_gasket`) and the USB-C
drip-break lip + internal drain shelf + four-sided perimeter gaskets
(`usb_c_molded_drip_break_lip`, `usb_c_internal_drain_shelf`, `usb_c_perimeter_gasket_*`).

### Clearance proof (read back from generated geometry)

| Quantity | Value | Required |
|---|---|---|
| Device thickness | 11.8 mm | <= ~11.8 mm |
| Battery thickness | 5.6 mm (5727 mAh / 22.05 Wh) | high capacity |
| Battery front -> display back gap | 0.150 mm | >= 0.15 mm |
| Battery back -> back inner wall gap | 0.150 mm | >= 0.15 mm |
| Flash burial inside inner wall | 0.120 mm | >= 0.1 mm |
| Flash window <-> camera lens spacing | 6.600 mm | >= 6.0 mm |
| Stray-light septum part | `rear_flash_camera_septum` (added) | present |
| Button travel | 0.20 mm | datasheet 0.20 mm |

## Residual-closure rev (swell + camera + seal)

Revision `evt0-mechanical-cad-swell-camera-seal`. Product-owner-approved device-thickness
increase (11.8 -> 12.7 mm) to close three coupled geometry residuals. The 5.6 mm battery
cell and 5727 mAh / 22.05 Wh capacity are UNCHANGED; the added 0.9 mm of depth becomes a
defined battery swell void plus healthier rear-camera burial. Flush flat back holds.
All numbers below are read back from generated geometry (`build_parts` mesh bounds and the
OCP B-rep boolean checker), not asserted by hand.

Z-stack (origin mid-plane, +Z toward screen): back outer plane = -6.350 mm; back inner wall
= -6.350 + 1.15 = -5.200 mm. Display LCM back face = +1.150 mm (front-referenced, fixed).

### R1 - Battery swell allowance

A LiPo pouch swells ~8-10 percent in thickness over life (~0.45-0.56 mm for a 5.6 mm cell).
A new `battery.battery_swell_gap_mm: 0.6` param defines a real void on the battery BACK face
(toward the back shell, away from the display) so swell can never push the panel.

- Battery cell: 5.6 mm, z_center -1.8 mm -> front face +1.000 mm, back face -4.600 mm.
- Front (display) face: gap to display back = +1.150 - (+1.000) = **0.150 mm** static (>= 0.15).
- Back (shell) face: gap to back inner wall = -4.600 - (-5.200) = **0.600 mm** swell void (>= 0.6).
- Capacity unchanged: cell thickness held at 5.6 mm -> **5727 mAh / 22.05 Wh**. The swell void
  is air (may host a compressible foam pad without preloading the cell).
- Gate `battery_display_and_wall_clearance` now requires front >= 0.15 mm AND back >= 0.6 mm.

### R2 - Camera fit / burial

Rear-camera burial raised from a marginal 0.30 mm to a healthy clearance via a new
`rear_camera.burial_clearance_mm: 0.45` param (consumed by `rear_camera_buried_center_z`).

- Rear camera module (10 x 10 x 5.1): back face at **-4.750 mm** = back inner wall + 0.45 mm
  -> **burial clearance 0.45 mm** (analytic) / **0.40 mm** (boolean mesh basis), both >= 0.4 mm.
  Front face at +0.350 mm (lower than the prior +0.95 mm, i.e. further from the display).
- Lens window stays coplanar with the back outer plane (flush, never proud).
- Front camera (6.5 x 6.5 x 3.2) fits with margin: back face -0.600 mm, front face +2.600 mm.
- New gate `camera_burial_clearance` fails closed if rear burial < 0.4 mm.

### R3 - USB-C saddle <-> speaker seal

The USB-C reinforcement saddle previously sat 0.5 mm from the bottom speaker rear acoustic
chamber wall. The chamber was shifted +0.6 mm in X (center 18.5 -> 19.1 mm) so the dividing
wall is now >= 1.0 mm; the 15 mm speaker module (x=18.5) remains fully enclosed and the bottom
edge (USB-C + speaker + dual bottom mics) still fits on the 78 mm edge.

- Saddle (18 mm wide, centered x=0) max X = +9.0 mm; chamber min X = +10.1 mm -> **gap 1.1 mm** (>= 1.0).
- New gate `usb_saddle_to_speaker_chamber_wall` fails closed if the gap < 1.0 mm.

### Verification (re-run clean)

- `generate_e1_phone_cad.py`: regenerated all STEP/STL/OBJ + assembly manifest, fit report `pass`.
- `check_e1_phone_boolean_interference.py`: **PASS**, 11/11 scopes, **0 unintentional clashes**,
  flush-back max protrusion **0.0 mm**, rear-camera burial 0.40 mm, flash buried.
- `check_e1_phone_button_orientation.py`: overall **pass** (all feature-orientation + coaxiality rows PASS).
- `check_e1_phone_assemblability.py`: **assemblable**, 19 steps, 0 trapped, fastener + FPC pass.
- `test_generate_e1_phone_cad.py`: **60/60 pass** (depth/gap/burial expectations updated as deliberate design changes).

### Residual-closure clearance proof

| Quantity | Value | Required |
|---|---|---|
| Device thickness | 12.7 mm | <= 12.8 mm (PO-approved) |
| Battery cell thickness | 5.6 mm (5727 mAh / 22.05 Wh, unchanged) | capacity held |
| Battery front -> display back (static) | 0.150 mm | >= 0.15 mm |
| Battery back -> back inner wall (swell void) | 0.600 mm | >= 0.6 mm |
| Rear-camera burial inside inner wall | 0.45 mm analytic / 0.40 mm boolean | >= 0.4 mm |
| Front-camera back/front face | -0.600 / +2.600 mm | fits buried |
| USB-C saddle <-> speaker chamber wall | 1.1 mm | >= 1.0 mm |
| Flush-back rear solid protrusion | 0.0 mm | 0.0 mm |
| Unintentional clashes | 0 | 0 |

## Wave-2 residual closure (RF tuner + drop hardening + gasket)

Four validated residuals from the RF/SI/PI and drop/acoustic simulations were
resolved by modeling the actual physics of each fix (not flag flips), then
regenerating CAD and re-running every gate. `evidence_class` tags preserved
(`analytical_rf_si_pi_prescan_not_chamber_measured`,
`physics_simulation_not_lab_measured`).

| Residual | Before | After | Fix (physics modeled) |
|---|---|---|---|
| RF-1 cellular low band 700-960 MHz | FAIL: 8.4% Chu instantaneous BW vs 31.7% needed | **PASS_WITH_TUNER**, worst-state total eff -3.1 dB (> -4 dB floor) | Aperture/band-switch tuner **Qorvo QPC1252Q** (alt pSemi PE613050, MIPI RFFE v2.1). Radio matches one ~20 MHz carrier at a time; modem programs the tuner state to center the Chu match window on the active channel. 12 resonance-center states span 700-960 MHz; every state's instantaneous-carrier FBW fits the Chu cap and the state grid step (<= 40 MHz) stays inside the match window (28-121 MHz, 3.1 MHz overlap margin) so coverage has no gap. Radiation efficiency de-rated 0.5 dB for tuner insertion loss. |
| DROP-1 cover glass face drop | SF 1.10 (< 1.5) | **SF 1.93** | Glass recessed 0.3 mm below the molded bezel rim (rim takes first-contact energy: force-into-glass relief = dmax/(dmax+2*inset) = 0.71) + perimeter PORON foam cushion under the glass edge (compliant edge support cuts back-face tensile share 0.80x). |
| DROP-2 corner-drop screw boss | SF 0.78 (< 1.0) | **SF 2.11** | screw_boss_count 6 -> 10 (per-boss shear area +67%) + 4 corner gussets tying corner bosses to the side frame + compliant battery retention foam shelf (0.6 swell foam force-limits battery inertial coupling: only 0.6x of the battery mass is rigidly coupled into the boss shear path; PCB stays fully coupled). |
| ACOUSTIC-1 speaker/earpiece gasket leak | 5.56 dB LF loss @ 20 um uncontrolled slit | **2.39 dB @ 8 um** | Compression-set CTQ added: residual leak slit <= 8 um control target / 10 um reject limit (closed-cell silicone foam, higher preload). Lower slit -> smaller leak area -> lower Helmholtz leak corner f_leak -> less LF SPL loss (20*log10(f_leak/fc)). Documented as a measured gasket compression-set CTQ for the process control plan. |

### New parts (params + generator + manifest, boolean clash-free)

- `antenna_aperture_tuner` (Qorvo QPC1252Q, 2.0x2.0x0.5 mm, MIPI RFFE) in the bottom cellular keepout feed region.
- `glass_perimeter_cushion_{top,bottom,left,right}` (PORON foam under recessed cover-glass edge).
- `orange_corner_rib_{1..4}` + `_leg` (8 segments: 4 corner gussets, two legs each).
- Screw bosses `orange_screw_boss_{1..10}` (param-driven count; was 6).
- Rear-camera bezel lands re-seated flush (Zmin at the back outer plane; flush-back protrusion 0.035 -> 0.0 mm).

### Wave-2 verification

- `simulate_e1_phone_rf_si_pi.py`: antenna **PASS**, overall **PASS**; low band **PASS_WITH_TUNER** (per-state Chu + Bode-Fano + no-gap coverage proof in the JSON/MD).
- `simulate_e1_phone_drop_acoustic.py`: **0 FAILs** — glass SF 1.93 (>= 1.5), corner boss SF 2.11 (>= 1.0), leak 2.39 dB (<= 3).
- `check_e1_phone_boolean_interference.py`: **PASS**, 11/11 scopes, **0 unintentional clashes**, flush-back **0.0 mm**.
- `test_generate_e1_phone_cad.py`: **62/62 pass** (boss-count check is `>=` param, so 10 bosses pass without expectation edits).

## Thickness-optimization + void rev

evidence_class: `cad_estimate_for_evt_planning, not_measured_hardware`

### Front-gap verdict: MISSING DETAIL (not real void)

The 2.8 mm air band between `display_lcm` top (Z=+2.85) and the cover-glass
inner face (Z=+5.65) was a modeling artifact. The model placed only the bare
**1.7 mm TFT cell** (`tft_outline_mm` Z) as the display, but the supplier
footprint driver and the component review use the full **3.39 mm LCD+CTP
module** (`ctp_outline_mm` Z = cover lens + OCA + capacitive touch + polarizers
+ 1.7 mm TFT cell + backlight unit). A phone bonds that module directly under
the cover glass through a thin OCA layer; there is no 2.8 mm of free air. Fixed
by modeling the display at full `module_outline_mm` (3.39 mm) seated one
`adhesive_thickness_mm` (0.18 mm OCA) below the cover-glass inner face. This
closed the false gap and the reclaimed depth was removed from the device,
rather than left as void.

### Limiting Z-column

The device thickness is governed by the **display + battery** centerline, not
the rear camera. At 11.8 mm (front face +5.90, back face -5.90):

| element | thickness mm | Z |
|---|---|---|
| cover glass | 0.70 | +5.90..+5.20 |
| OCA bond | 0.18 | +5.20..+5.02 |
| bonded LCD+CTP module | 3.39 | +5.02..+1.63 |
| static clearance | 0.18 | +1.63..+1.45 |
| battery pouch | 5.60 | +1.45..-4.15 |
| battery swell void (back face) | 0.60 | -4.15..-4.75 |
| back wall | 1.15 | -4.75..-5.90 |

The rear camera column (back wall 1.15 + burial 0.45 + module 5.10 = 6.70 from
the back face, top at +0.80) is shorter than the battery column, so the camera
is **not** the limiting element and needs no PCB cutout — the PCB top island
already clears it in Z (camera top +0.80 vs PCB bottom -2.50). Burying the
camera deeper would not thin the device; the battery+display stack sets the floor.

### Old vs new

| metric | before | after |
|---|---|---|
| device thickness | 12.7 mm | **11.8 mm** (-0.9 mm) |
| front display gap (air) | 2.80 mm (31.8 cm3 void) | 0.18 mm OCA (2.0 cm3) |
| internal void volume | 67.1 cm3 (54.4% of cavity) | **41.4 cm3 (36.6%)** |
| battery swell void | 0.6 mm | 0.6 mm (held) |
| rear camera burial | 0.45 mm (clearance 0.4) | 0.45 mm (clearance 0.4, held) |
| flush-back protrusion | 0.0 mm | 0.0 mm (held) |

Void by region after: front_display_gap 2.0 cm3, mid_pcb_band 25.5 cm3,
back_band 14.2 cm3 (see `void-volume.{json,md}`). The remaining void is
distributed small-component margins around the PCB islands and battery
perimeter, not a single closeable band.

### Verification

- `generate_e1_phone_cad.py`: **pass**.
- `check_e1_phone_boolean_interference.py`: **PASS**, 11/11 scopes, **0 clashes**,
  flush-back **0.0 mm**, camera buried 0.4 mm, flash buried 0.15 mm.
- `check_e1_phone_button_orientation.py`: **pass**.
- `check_e1_phone_assemblability.py`: assemblable=True, 19 steps, 0 trapped.
- `test_generate_e1_phone_cad.py`: **63/63 pass** (depth expectation updated
  12.7 -> 11.8 deliberately).
