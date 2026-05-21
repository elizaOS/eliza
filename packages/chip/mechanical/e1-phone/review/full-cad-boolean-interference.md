# E1 Phone Full CAD Boolean Interference Acceptance

Status: FAIL.

Engine: `OCP.BRepAlgoAPI_Common + BRepExtrema_DistShapeShape`.
Date: 2026-05-20. Reviewer: `automated_boolean_check`.
Parts loaded: 94/94. Pair count: 4371 (BRep-evaluated: 302).
Unintentional clash pairs: 1.

## Scope Cases

| Case | Parts | Min gap (mm) | Interference vol (mm3) | Status |
|------|-------|--------------|------------------------|--------|
| `screen_stack_to_orange_rails` | 5/5 | 5.55 | 0.0 | PASS |
| `routed_pcb_components_to_orange_enclosure` | 6/6 | 1.9 | 0.0 | PASS |
| `usb_c_port_saddle_aperture_and_gaskets` | 9/9 | 0.0 | 0.0 | PASS |
| `side_buttons_switches_gaskets_labyrinth` | 9/9 | 77.1 | 0.0 | PASS |
| `front_camera_earpiece_under_glass_stack` | 7/7 | 2.86 | 0.0 | PASS |
| `rear_camera_window_baffle_adhesive_stack` | 8/8 | 0.25 | 0.0 | PASS |
| `rear_flash_torch_window_back_wall` | 6/6 | 0.25 | 0.0 | PASS |
| `battery_pouch_pcb_flex_haptic` | 4/4 | 0.01 | 0.0 | PASS |
| `bottom_audio_microphone_speaker_meshes` | 9/9 | 6.53 | 0.0 | PASS |
| `rf_shields_antennas_plastic_windows` | 6/6 | 0.0 | 0.0 | PASS |
| `molded_retention_boss_snap_service_features` | 8/8 | 0.0 | 0.0 | PASS |

## Flush-Back / Burial Geometry

Back outer plane Z = -5.6 mm. Flush-back `flush_back_no_rear_protrusion`: max solid protrusion = 0.0 mm (PASS).
- Envelope/void excursions (not solid, not a fault): `service_label_recess` (0.205mm)

Burial vs back inner wall (Z = -4.4 mm); clearance >= 0 means back face at or inside the wall:
- `rear_camera_module`: back face Zmin = -4.15 mm, burial clearance = 0.25 mm (BURIED)
- `rear_flash_led`: back face Zmin = -4.45 mm, burial clearance = -0.05 mm (EXPOSED)

## Missing Or Incomplete Boolean Results



## Release Rule

Every scope must be checked with a named boolean engine against supplier B-rep models and routed KiCad board STEP, with min gap >= 0, zero interference count, zero interference volume, reviewer, and explicit pass.
