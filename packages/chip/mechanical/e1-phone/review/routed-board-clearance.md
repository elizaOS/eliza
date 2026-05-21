# E1 Phone Routed Board Clearance

Status: blocked_waiting_for_routed_board_step.

This gate keeps the concept PCB envelope from being treated as final routed-board clearance evidence.

## Rerun Matrix

- P1 PASS: `battery_to_pcb_islands` concept 0.5 mm, required 0.5 mm, margin 0.0 mm; high_less_than_0p1mm_margin; rerun required
  Measurement: Tight concept margin leaves little room for routed footprint, tolerance, or supplier STEP variation.
- P1 PASS: `split_interconnect_connectors_on_pcb_islands` concept 0.0 mm, required 0.0 mm, margin 0.0 mm; high_zero_nominal_clearance; rerun required
  Measurement: Zero-clearance concept registration must be checked for routed component body and solder fillet interference.
- P1 PASS: `usb_shell_to_external_aperture` concept 0.175 mm, required 0.15 mm, margin 0.025 mm; high_less_than_0p1mm_margin; rerun required
  Measurement: Tight concept margin leaves little room for routed footprint, tolerance, or supplier STEP variation.
- P3 PASS: `bottom_mic_to_usb` concept 11.78 mm, required 1.0 mm, margin 10.78 mm; medium_functional_interface; rerun required
  Measurement: Functional interface clearance affects assembly, service, or user-facing fit.
- P3 PASS: `front_camera_to_earpiece` concept 9.75 mm, required 1.0 mm, margin 8.75 mm; medium_functional_interface; rerun required
  Measurement: Functional interface clearance affects assembly, service, or user-facing fit.
- P3 PASS: `rear_camera_to_battery` concept 16.3 mm, required 2.0 mm, margin 14.3 mm; medium_functional_interface; rerun required
  Measurement: Functional interface clearance affects assembly, service, or user-facing fit.
- P3 PASS: `split_interconnect_flex_to_battery_edge` concept 1.3 mm, required 0.5 mm, margin 0.8 mm; medium_functional_interface; rerun required
  Measurement: Functional interface clearance affects assembly, service, or user-facing fit.
- P3 PASS: `split_interconnect_flex_within_side_rail` concept 3.3 mm, required 1.5 mm, margin 1.8 mm; medium_functional_interface; rerun required
  Measurement: Functional interface clearance affects assembly, service, or user-facing fit.
- P3 PASS: `usb_to_bottom_speaker` concept 6.53 mm, required 1.0 mm, margin 5.53 mm; medium_functional_interface; rerun required
  Measurement: Functional interface clearance affects assembly, service, or user-facing fit.
- P4 PASS: `haptic_to_pcb_islands` concept 1.118 mm, required 0.5 mm, margin 0.618 mm; standard; rerun required
  Measurement: Measure during the routed-board clearance rerun.

## Missing Or Incomplete Routed Results

- `battery_to_pcb_islands`
- `bottom_mic_to_usb`
- `front_camera_to_earpiece`
- `haptic_to_pcb_islands`
- `rear_camera_to_battery`
- `split_interconnect_connectors_on_pcb_islands`
- `split_interconnect_flex_to_battery_edge`
- `split_interconnect_flex_within_side_rail`
- `usb_shell_to_external_aperture`
- `usb_to_bottom_speaker`

## Release Rule

- Routed-board clearance passes only after routed KiCad STEP is available, all height-critical component models are present, every rerun case is measured, every minimum gap is met, and every interference count is zero.
