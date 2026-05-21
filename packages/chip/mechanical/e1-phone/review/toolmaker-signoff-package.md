# E1 Phone Toolmaker Signoff Package

Status: request package ready; toolmaker signoff not returned.

## Request Items

- `mold_flow_fill_pack_warp` Run fill/pack/warp simulation on orange PC+ABS shell and side-frame tool concept.
  Linked tooling features: back_shell_main_draw, camera_window_and_acoustic_slots, parting_line_critical_venting
  Acceptance threshold: No short shot; weld lines, air traps, sink, shrink, and warp risks mapped to every A-surface and functional aperture.
  Required return: Mold-flow report with pressure, fill time, weld lines, air traps, sink, shrink, and warp plots.
  Required artifacts: fill_pack_warp_report, weld_air_sink_overlay, a_surface_risk_markup
  Required decisions: short_shot_clearance, cosmetic_weld_line_disposition, functional_aperture_risk_disposition
  Numeric outputs: peak_fill_pressure_mpa, max_glass_ledge_warp_mm, max_a_surface_sink_mm
- `gate_runner_balance` Review dual submarine gate and cold-runner layout against cosmetic gate vestige limits.
  Linked tooling features: back_shell_main_draw, usb_c_bottom_aperture_shutoff, camera_window_and_acoustic_slots
  Acceptance threshold: Gate vestige off cosmetic hero surfaces; gate area and runner balance signed against orange blush/streak limits.
  Required return: Signed gate/runner recommendation with gate land, gate area, vestige location, and alternate fan-gate decision.
  Required artifacts: gate_runner_layout_markup, gate_vestige_location_drawing, alternate_gate_decision
  Required decisions: selected_gate_strategy, orange_blush_risk_disposition, fan_gate_fallback_disposition
  Numeric outputs: gate_land_mm, gate_area_mm2, runner_balance_percent
- `ejector_layout` Review modeled ejector pins against non-cosmetic surfaces, boss support, and part release.
  Linked tooling features: screw_boss_core_pins, snap_hook_release, back_shell_main_draw
  Acceptance threshold: Ejector marks hidden from A-surfaces; boss and snap-hook release forces signed by toolmaker.
  Required return: Ejector layout markup with witness-mark acceptance and any added blade/sleeve ejectors.
  Required artifacts: ejector_layout_markup, witness_mark_acceptance_map, boss_snap_release_review
  Required decisions: a_surface_ejector_exclusion, boss_support_disposition, snap_hook_release_strategy
  Numeric outputs: ejector_pin_count, minimum_ejector_to_a_surface_mm, estimated_ejection_force_n
- `cooling_layout` Review straight cooling-channel placeholders and propose production baffles or conformal cooling.
  Linked tooling features: back_shell_main_draw, screw_boss_core_pins, camera_window_and_acoustic_slots
  Acceptance threshold: Cooling circuits cover boss, camera, USB-C, and long rail hot spots with expected cycle-time and warp impact.
  Required return: Cooling layout with channel diameter, clearance, circuiting, expected cycle time, and hot-spot risk.
  Required artifacts: cooling_layout_drawing, hotspot_risk_map, cycle_time_estimate
  Required decisions: baffle_or_conformal_cooling_decision, boss_hotspot_disposition, camera_usb_hotspot_disposition
  Numeric outputs: cooling_channel_diameter_mm, minimum_channel_to_steel_mm, predicted_cycle_time_s
- `shrink_warp_allowance` Confirm resin shrink, steel-safe stock, datum scheme, and CMM tuning plan.
  Linked tooling features: back_shell_main_draw, usb_c_bottom_aperture_shutoff, side_button_openings, camera_window_and_acoustic_slots
  Acceptance threshold: Steel-safe offsets tied to GD&T datums for glass bond ledge, USB-C aperture, buttons, camera, bosses, and rails.
  Required return: Shrink/warp allowance table tied to GD&T datums and first-article CMM plan.
  Required artifacts: shrink_allowance_table, steel_safe_stock_plan, first_article_cmm_plan
  Required decisions: resin_shrink_basis, datum_scheme_disposition, steel_tuning_iteration_plan
  Numeric outputs: in_plane_shrink_percent, through_thickness_shrink_percent, steel_safe_stock_mm
- `orange_cmf_texture` Approve hard orange PC+ABS color, gloss, texture depth, gate blush tolerance, and scratch samples.
  Linked tooling features: back_shell_main_draw, camera_window_and_acoustic_slots
  Acceptance threshold: Orange plaques pass color/gloss/texture limits and gate-blush samples under production lighting.
  Required return: Color plaque, texture plaque, gate-blush limit sample, and signed CMF acceptance criteria.
  Required artifacts: orange_color_plaque_photo, texture_plaque_photo, gate_blush_limit_sample, signed_cmf_criteria
  Required decisions: orange_color_match_disposition, texture_depth_disposition, scratch_rub_disposition
  Numeric outputs: delta_e_orange, gloss_units_60deg, texture_depth_um
- `first_shot_doe` Quote and approve first-shot DOE covering melt temperature, mold temperature, pack pressure, hold time, and cooling time.
  Linked tooling features: back_shell_main_draw, screw_boss_core_pins, parting_line_critical_venting
  Acceptance threshold: DOE includes dimensional CMM, cosmetic inspection, short-shot/fill, flash, sink, warp, and assembly fit runs.
  Required return: DOE run sheet and acceptance plan for first shots before DVT tool tuning.
  Required artifacts: first_shot_doe_run_sheet, dimensional_cmm_sampling_plan, cosmetic_and_assembly_acceptance_plan
  Required decisions: doe_factor_matrix, short_shot_flash_sink_warp_disposition, assembly_fit_trial_disposition
  Numeric outputs: melt_temp_low_high_c, pack_pressure_low_high_mpa, sample_count_per_condition

## Critical Molded Features

- PASS: `back_shell_main_draw` straight_pull_a_b_open_close
  Feature: orange_back_shell_and_side_frame_outer_surfaces
  Tooling note: Use the modeled mid-plane parting reference as a concept split; final shutoffs depend on production B-rep surfaces.
- PASS: `screw_boss_core_pins` fixed_core_pins_from_b_side
  Feature: six_screw_boss_cores
  Tooling note: Every boss needs a core pin and steel-safe local tuning to reduce sink/read-through.
- PASS: `snap_hook_release` toolmaker_review_lifters_or_straight_pull_hook_redesign
  Feature: eight_side_snap_hooks
  Tooling note: Current snap hooks prove retention intent; toolmaker must approve lifter/slide strategy or revise hooks to straight-pull geometry.
- PASS: `usb_c_bottom_aperture_shutoff` bottom_edge_shutoff_insert_or_local_side_core_with_gasket_seat_review
  Feature: usb_c_external_aperture_reinforcement_saddle_gasket_seat_and_drain_shelf
  Tooling note: USB-C mouth needs steel-safe shutoff and gasket-seat review so insertion loads, splash management, and cosmetics survive first shots.
- PASS: `side_button_openings` side_core_lifter_or_secondary_operation_decision
  Feature: power_and_volume_button_side_openings
  Tooling note: Button openings are side-wall features; choose a slide/lifter strategy or keep caps mounted through an insert before hard tooling.
- PASS: `camera_window_and_acoustic_slots` steel_safe_inserts_and_vented_shutoffs
  Feature: rear_camera_window_front_under_glass_earpiece_and_speaker_ports
  Tooling note: Camera and acoustic apertures need insert/shutoff, adhesive-seat, baffle, venting, and flash-control review before texture freeze.
- PASS: `parting_line_critical_venting` parting_line_micro_vents_and_toolmaker_air_trap_markup
  Feature: end_of_fill_usb_camera_acoustic_and_snap_hook_air_traps
  Tooling note: Modeled vent slots make the air-trap plan visible before mold-flow; toolmaker must still size vents to resin and flash limits.

## Process Window

- Melt temperature: 245-275 C
- Mold temperature: 70-95 C
