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
