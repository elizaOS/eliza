# E1 Phone Injection Molding DFM Screen

Status: CAD-derived DFM inputs ready; mold-flow and toolmaker signoff still required.

## Checks

- PASS: `nominal_wall` actual 1.15 target 0.9-1.4 mm phone-shell PC+ABS concept window risk low
- PASS: `rib_to_wall_ratio` actual 0.652 target <= 0.70 risk medium
- PASS: `boss_wall_to_nominal_wall` actual 1.043 target <= 1.10 risk medium
- PASS: `draft_angle` actual 2.0 target >= 2.0 degrees for textured orange plastic risk low
- PASS: `internal_radius` actual 0.6 target >= 0.5 mm risk low
- PASS: `submarine_gate_ratio` actual 0.739 target <= 0.80 x nominal wall risk medium
- PASS: `runner_diameter` actual 2.2 target >= 2.0 mm risk low
- PASS: `ejector_pin_count` actual 8 target 8 modeled pins risk medium
- PASS: `cooling_channel_clearance` actual 2.0 target >= 2.0 channel diameters from cavity risk medium

## Risks

- `long_thin_flow_path`: high; Keep dual gates, consider fan-gate alternate, and run mold-flow before freezing tool steel.
- `orange_color_match_and_gate_blush`: medium; Use color-chip approval, textured sample plaques, and gate vestige location review.
- `boss_sink_and_read_through`: medium; Core every boss, add local texture, and keep bosses off visible hero surfaces where possible.
- `snap_hook_fatigue`: medium; Prototype snap cycles in the selected resin and tune hook root radius after first shots.

## Mold Action Plan

- PASS: `back_shell_main_draw` straight_pull_a_b_open_close; Use the modeled mid-plane parting reference as a concept split; final shutoffs depend on production B-rep surfaces.
- PASS: `screw_boss_core_pins` fixed_core_pins_from_b_side; Every boss needs a core pin and steel-safe local tuning to reduce sink/read-through.
- PASS: `snap_hook_release` toolmaker_review_lifters_or_straight_pull_hook_redesign; Current snap hooks prove retention intent; toolmaker must approve lifter/slide strategy or revise hooks to straight-pull geometry.
- PASS: `usb_c_bottom_aperture_shutoff` bottom_edge_shutoff_insert_or_local_side_core_with_gasket_seat_review; USB-C mouth needs steel-safe shutoff and gasket-seat review so insertion loads, splash management, and cosmetics survive first shots.
- PASS: `side_button_openings` side_core_lifter_or_secondary_operation_decision; Button openings are side-wall features; choose a slide/lifter strategy or keep caps mounted through an insert before hard tooling.
- PASS: `camera_window_and_acoustic_slots` steel_safe_inserts_and_vented_shutoffs; Camera and acoustic apertures need insert/shutoff, venting, and flash-control review before texture freeze.

## Toolmaker Requests

- Ask toolmaker for mold-flow/fill/pack/warp study using selected orange PC+ABS resin.
- Review submarine gate vestige on bottom/back edge against the Teenage Engineering/Rabbit-style cosmetic target.
- Add steel-safe tuning allowance around USB aperture, button plungers, and camera cover-glass window.
- Confirm ejector witness marks stay inside non-cosmetic surfaces or are hidden by internal stack.
- Use first-shot CMM and color/texture plaques before approving DVT enclosure samples.
