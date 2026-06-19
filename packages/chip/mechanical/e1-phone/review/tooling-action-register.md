# E1 Phone Tooling Action Register

Status: cad_tooling_action_register_ready.

This register turns the CAD DFM screen into toolmaker actions and remains fail-closed until returned evidence is recorded.

## Actions

- PASS: `back_shell_main_draw` straight_pull_a_b_open_close (medium risk)
- PASS: `screw_boss_core_pins` fixed_core_pins_from_b_side (medium risk)
- PASS: `snap_hook_release` toolmaker_review_lifters_or_straight_pull_hook_redesign (medium risk)
- PASS: `usb_c_bottom_aperture_shutoff` bottom_edge_shutoff_insert_or_local_side_core_with_gasket_seat_review (medium risk)
- PASS: `side_button_openings` side_core_lifter_or_secondary_operation_decision (medium risk)
- PASS: `camera_window_and_acoustic_slots` steel_safe_inserts_and_vented_shutoffs (medium risk)
- PASS: `orange_cmf_texture_gate_review` approve orange resin chip, texture plaque, gloss target, and gate vestige location (medium risk)
- PASS: `first_shot_metrology_loop` run first-shot CMM, flatness, boss position, aperture, and snap retention feedback loop (medium risk)

## Release Rule

- Every action must have returned marked-up tool design or physical sample evidence, toolmaker/reviewer disposition, and any required mold-flow or first-shot records before injection-tool release.
