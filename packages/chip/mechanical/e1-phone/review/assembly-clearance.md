# E1 Phone Assembly Clearance Report

Status: targeted CAD clearance checks.

## Cases

- PASS: `screen_cover_glass_to_orange_body` actual 0.45 mm, required 0.3 mm
- PASS: `display_lcm_under_cover_glass` actual 3.16 mm, required 0.5 mm
- PASS: `usb_shell_to_external_aperture` actual 0.175 mm, required 0.15 mm
- PASS: `usb_to_bottom_speaker` actual 6.53 mm, required 1.0 mm
- PASS: `bottom_mic_to_usb` actual 11.78 mm, required 1.0 mm
- PASS: `battery_to_pcb_islands` actual 0.5 mm, required 0.5 mm
- PASS: `split_interconnect_flex_to_battery_edge` actual 1.3 mm, required 0.5 mm
- PASS: `split_interconnect_flex_within_side_rail` actual 3.3 mm, required 1.5 mm
- PASS: `split_interconnect_connectors_on_pcb_islands` actual 0.0 mm, required 0.0 mm
- PASS: `haptic_to_battery` actual 0.5 mm, required 0.5 mm
- PASS: `haptic_to_pcb_islands` actual 1.118 mm, required 0.5 mm
- PASS: `haptic_to_sim_tray_keepout` actual 9.001 mm, required 0.5 mm
- PASS: `rear_camera_to_battery` actual 16.3 mm, required 2.0 mm
- PASS: `front_camera_to_earpiece` actual 9.75 mm, required 1.0 mm

## Full-Assembly Boolean Check

Engine: `OCP.BRepAlgoAPI_Common + BRepExtrema_DistShapeShape`. Date: 2026-05-20. Reviewer: `automated_boolean_check`.
Overall: PASS. Scopes: 11/11 pass. Unintentional clash pairs: 0.
