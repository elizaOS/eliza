# E1 Phone Supplier Evidence Acceptance

Status: blocked_no_supplier_evidence.

This gate keeps public sourcing shortlists and RFQ drafts separate from supplier-returned CAD lock evidence.

## Families

- BLOCKED: `display_touch_stack`
  Required items: display_lcm_ctp
  Required evidence: quote, 2d_drawing, step_model, sample, fpc_pinout, mating_connector, touch_display_bringup_data
  Required artifacts: display_sample_photos, fpc_pinout_and_mating_connector, native_or_step_stack_model, signed_2d_stack_drawing
  Required decisions: cover_glass_bonded_or_separate, fpc_exit_side_and_bend_radius, touch_controller_and_init_sequence
  Validation outputs: active_area_offset_mm, connector_stack_height_mm, outline_tolerance_mm
  Missing evidence: quote, 2d_drawing, step_model, sample, fpc_pinout, mating_connector, touch_display_bringup_data
  Missing supplier items: display_lcm_ctp
- BLOCKED: `usb_audio_bottom_io`
  Required items: usb_c
  Required evidence: quote, 2d_drawing, step_model, sample, usb_land_pattern, insertion_force_data, splash_gasket_review
  Required artifacts: gasket_or_splash_path_review, pcb_land_pattern, signed_receptacle_2d_drawing, step_model_with_shell_stakes
  Required decisions: exact_connector_suffix, gasket_seat_acceptance, mid_mount_or_top_mount_orientation
  Validation outputs: insertion_force_n, mating_cycle_rating, shell_stake_tolerance_mm
  Missing evidence: quote, 2d_drawing, step_model, sample, usb_land_pattern, insertion_force_data, splash_gasket_review
  Missing supplier items: usb_c
- BLOCKED: `power_volume_buttons`
  Required items: side_buttons
  Required evidence: quote, 2d_drawing, step_model, sample, force_travel_curve, gasket_material_spec, compression_set_data
  Required artifacts: cap_and_actuator_stack_drawing, sample_force_curve, silicone_gasket_material_spec, switch_drawing
  Required decisions: flex_or_direct_pcb_mount, power_switch_part_number, volume_switch_part_number
  Validation outputs: actuation_force_n, compression_set_percent, travel_mm
  Missing evidence: quote, 2d_drawing, step_model, sample, force_travel_curve, gasket_material_spec, compression_set_data
  Missing supplier items: side_buttons
- BLOCKED: `camera_modules`
  Required items: rear_camera, front_camera
  Required evidence: quote, 2d_drawing, step_model, sample, fpc_pinout, optical_center_datum, sample_capture_evidence
  Required artifacts: behind_glass_sample_capture, fpc_pinout_and_connector, sample_capture_evidence, signed_module_2d_drawing, step_model_with_lens_stack
  Required decisions: black_mask_aperture_size, fpc_exit_side, optical_center_datum, sensor_and_lens_variant, under_glass_placement_datum
  Validation outputs: glass_to_lens_gap_mm, lens_center_offset_mm, minimum_focus_distance_mm, module_total_height_mm
  Missing evidence: quote, 2d_drawing, step_model, sample, fpc_pinout, optical_center_datum, sample_capture_evidence
  Missing supplier items: rear_camera, front_camera
- BLOCKED: `wireless_modules`
  Required items: cellular_redcap, wifi_bt
  Required evidence: quote, 2d_drawing, step_model, sample, pinout_reference_design, antenna_keepout, certification_path
  Required artifacts: antenna_matching_reference, antenna_reference_design, module_datasheet, module_step_model, pinout_and_land_pattern, pinout_and_reference_schematic
  Required decisions: antenna_feed_strategy, certification_path, coexistence_interface, module_or_chip_down, regional_sku, rf_connector_or_solder_feed
  Validation outputs: antenna_clearance_mm, antenna_keepout_mm, module_height_mm, peak_current_a, thermal_dissipation_w
  Missing evidence: quote, 2d_drawing, step_model, sample, pinout_reference_design, antenna_keepout, certification_path
  Missing supplier items: cellular_redcap, wifi_bt
- BLOCKED: `orange_enclosure_tooling`
  Required items: orange_enclosure_tooling
  Required evidence: toolmaker_quote, tool_drawing, mold_flow_plan, orange_color_sample, dfm_markup, gate_runner_ejector_strategy, texture_color_standard
  Required artifacts: dfm_markup, orange_plaque_or_first_shot_photo, tool_layout_drawing, tooling_quote
  Required decisions: gate_runner_ejector_strategy, texture_and_color_standard, tool_class_and_cavity_count
  Validation outputs: delta_e_orange, estimated_part_cost_usd_20, tooling_lead_time_days
  Missing evidence: toolmaker_quote, tool_drawing, mold_flow_plan, orange_color_sample, dfm_markup, gate_runner_ejector_strategy, texture_color_standard
  Missing supplier items: orange_enclosure_tooling

## Release Rule

- Every supplier family must have returned quote, 2D drawing, STEP/native CAD, physical sample evidence, and reviewer identity before replacing EVT0 envelope CAD or locking the phone for tooling.
