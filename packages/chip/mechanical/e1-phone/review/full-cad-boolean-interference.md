# E1 Phone Full CAD Boolean Interference Acceptance

Status: PASS.

Engine: `OCP.BRepAlgoAPI_Common + BRepExtrema_DistShapeShape`.
Date: 2026-05-20. Reviewer: `automated_boolean_check`.
Parts loaded: 123/123. Pair count: 7503 (BRep-evaluated: 465).
Unintentional clash pairs: 0.

## Scope Cases

| Case | Parts | Min gap (mm) | Interference vol (mm3) | Status |
|------|-------|--------------|------------------------|--------|
| `screen_stack_to_orange_rails` | 5/5 | 6.33 | 0.0 | PASS |
| `routed_pcb_components_to_orange_enclosure` | 6/6 | 2.2 | 0.0 | PASS |
| `usb_c_port_saddle_aperture_and_gaskets` | 9/9 | 0.0 | 0.0 | PASS |
| `side_buttons_switches_gaskets_labyrinth` | 9/9 | 77.1 | 0.0 | PASS |
| `front_camera_earpiece_under_glass_stack` | 7/7 | 3.16 | 0.0 | PASS |
| `rear_camera_window_baffle_adhesive_stack` | 8/8 | 0.5 | 0.0 | PASS |
| `rear_flash_torch_window_back_wall` | 6/6 | 0.5 | 0.0 | PASS |
| `battery_pouch_pcb_flex_haptic` | 4/4 | 0.01 | 0.0 | PASS |
| `bottom_audio_microphone_speaker_meshes` | 9/9 | 6.53 | 0.0 | PASS |
| `rf_shields_antennas_plastic_windows` | 6/6 | 0.0 | 0.0 | PASS |
| `molded_retention_boss_snap_service_features` | 8/8 | 0.0 | 0.0 | PASS |

## Flush-Back / Burial Geometry

Back outer plane Z = -5.9 mm. Flush-back `flush_back_no_rear_protrusion`: max solid protrusion = 0.0 mm (PASS).
- Envelope/void excursions (not solid, not a fault): `rear_camera_shell_aperture` (0.055mm), `rear_flash_shell_aperture` (0.055mm), `service_label_recess` (0.205mm)

## Rear Camera Back-Shell Hole

Status: PASS. Aperture clears cover glass XY: True.
- `orange_back_shell` vs `rear_camera_cover_glass`: intersection 0.0 mm3, min gap 0.7 mm (PASS)
- `orange_back_shell` vs `rear_camera_lens_window`: intersection 0.0 mm3, min gap 1.9 mm (PASS)
- `orange_back_shell` vs `rear_camera_module`: intersection 0.0 mm3, min gap 0.5 mm (PASS)

## Rear Flash Back-Shell Hole

Status: PASS. Aperture clears flash window XY: True.
- `orange_back_shell` vs `rear_flash_led_window`: intersection 0.0 mm3, min gap 0.3 mm (PASS)
- `orange_back_shell` vs `rear_flash_led`: intersection 0.0 mm3, min gap 0.618466 mm (PASS)

## Handset Cover-Glass Slot

Status: PASS.
- `screen_cover_glass` vs `handset_acoustic_slot`: intersection 0.0 mm3, min gap 0.15 mm (PASS)
- `screen_cover_glass` vs `handset_acoustic_mesh`: intersection 0.0 mm3, min gap 0.05 mm (PASS)

## Side-Frame External Cutouts

Status: PASS.
- `orange_side_frame` vs `usb_c_external_aperture`: intersection 0.0 mm3, min gap 0.3 mm (PASS)
- `orange_side_frame` vs `bottom_speaker_grille_slot_1`: intersection 0.0 mm3, min gap 0.075 mm (PASS)
- `orange_side_frame` vs `bottom_speaker_grille_slot_2`: intersection 0.0 mm3, min gap 0.075 mm (PASS)
- `orange_side_frame` vs `bottom_speaker_grille_slot_3`: intersection 0.0 mm3, min gap 0.075 mm (PASS)
- `orange_side_frame` vs `bottom_speaker_grille_slot_4`: intersection 0.0 mm3, min gap 0.075 mm (PASS)
- `orange_side_frame` vs `bottom_speaker_grille_slot_5`: intersection 0.0 mm3, min gap 0.075 mm (PASS)
- `orange_side_frame` vs `bottom_microphone_port_1`: intersection 0.0 mm3, min gap 0.1 mm (PASS)
- `orange_side_frame` vs `bottom_microphone_port_2`: intersection 0.0 mm3, min gap 0.1 mm (PASS)
- `orange_side_frame` vs `top_microphone_port`: intersection 0.0 mm3, min gap 0.1 mm (PASS)
- Captured mesh insert contacts reported as intentional seal envelopes.

Burial vs back inner wall (Z = -4.7 mm); clearance >= 0 means back face at or inside the wall:
- `rear_camera_module`: back face Zmin = -4.3 mm, burial clearance = 0.4 mm (BURIED)
- `rear_flash_led`: back face Zmin = -4.55 mm, burial clearance = 0.15 mm (BURIED)

## Missing Or Incomplete Boolean Results

_(none — every scope has measured B-rep boolean results)_

## Release Rule

Every scope must be checked with a named boolean engine against supplier B-rep models and routed KiCad board STEP, with min gap >= 0, zero interference count, zero interference volume, reviewer, and explicit pass.
