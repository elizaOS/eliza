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
| Device envelope (mm) | 78.0 x 153.6 x 9.6 | 78.0 x 153.6 x 11.2 |
| Back face | camera lens window proud, cosmetic ring | fully flush flat back, no bump, no ring |
| Battery envelope (mm) | 64.0 x 87.0 x 4.4 | 64.0 x 87.0 x 5.7 |
| Battery capacity | 4500 mAh / 17.33 Wh | 5830 mAh / 22.45 Wh |
| Rear camera | single AF module, proud lens window | single simple-AF module, buried, flush window |
| Front camera | single fixed-focus module | single fixed-focus module (unchanged) |
| Rear torch/flash | none | single buried white flash LED + flush window |
| Rear cosmetic tolerance | `rear_camera_ring_vs_glass_mm` 0.10 +/-0.10 | `rear_camera_window_flush_to_back_mm` 0.0 +/-0.05 |
| Buttons | Panasonic EVQ-P7 (power + volume) | unchanged; annotated `standardized_part: Panasonic EVQ-P7xxx` |

## Z-stack math (origin at mid-plane, +Z toward screen, -Z toward back)

Depth D = 11.2 mm. Back outer plane at z = -D/2 = -5.600 mm. Back wall = 1.15 mm, so the
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

11.2 mm is selected (within the 11.0-11.5 mm target band) to give margin for the thicker
battery, ribs, and assembly tolerance while keeping the back truly flush.

Tolerance-stack `nominal_z_stack_margin` = D - (cover_glass 0.70 + adhesive 0.18 + pcb 0.80
+ battery 5.70 + 1.20) = 11.2 - 8.58 = 2.62 mm (>= 1.0 mm required).

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
