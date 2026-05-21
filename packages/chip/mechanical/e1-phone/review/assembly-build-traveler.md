# E1 Phone Assembly Build Traveler

Status: blocked_no_assembly_build_results.

This traveler blocks end-to-end assembly readiness until a real unit build record is populated.

## Steps

- PASS: `incoming_supplier_part_inspection` at `incoming_quality` - supplier drawing/STEP/sample identity checked before build start
  Required measurements: supplier_lot_id, drawing_revision, step_model_revision, incoming_sample_identity, critical_dimension_spot_check
  Evidence artifacts: supplier-response-review.json, supplier-evidence-acceptance.json, supplier-drawing-intake-checklist.yaml
  Stop rule: Do not start assembly if any supplier identity, CAD revision, or sample record is missing.
- PASS: `screen_adhesive_and_display_bond` at `display_bond` - adhesive compression, FPC bend radius, luminance, touch grid, and drop/lift checks pass
  Required measurements: display_bond_peel_n_per_mm, screen_adhesive_compression_mm, display_fpc_bend_radius_mm, display_luminance_cd_m2, touch_grid_pass, display_dsi_bringup_logs
  Evidence artifacts: display-validation.json, display-results-review.json, evt-inspection-plan.json
  Stop rule: Stop build on screen lift, adhesive under-compression, FPC overbend, touch failure, or no DSI bring-up log.
- PASS: `top_bottom_pcb_islands_and_split_flex` at `pcb_flex_integration` - top/bottom board connector seating, flex strain relief, continuity, and battery window clearance pass
  Required measurements: top_connector_seating_visual, bottom_connector_seating_visual, split_flex_continuity_ohm, battery_window_clearance_mm, flex_strain_relief_visual
  Evidence artifacts: interface-validation.json, assembly-clearance.json, routed-board-clearance.json
  Stop rule: Stop build on connector mis-seat, flex continuity failure, battery-window clash, or missing routed-board clearance evidence.
- PASS: `camera_handset_and_acoustic_stack` at `optical_audio_stack` - camera alignment, dust/baffle inspection, speaker/mic/earpiece leak, and streaming/audio checks pass
  Required measurements: rear_camera_center_offset_mm, front_camera_center_offset_mm, camera_dust_baffle_visual, speaker_leak_db, earpiece_leak_db, mic_sensitivity_dbfs, camera_streaming_capture_log
  Evidence artifacts: camera-validation.json, camera-results-review.json, acoustic-validation.json, acoustic-results-review.json
  Stop rule: Stop build on camera decenter, dust, acoustic leak, blocked mesh, mic outlier, or missing capture/audio logs.
- PASS: `usb_buttons_haptics_and_ingress_seals` at `side_bottom_io` - USB insertion, post-cycle continuity, button force/travel/cycle, haptic clearance, and seal inspection pass
  Required measurements: usb_c_insertion_force_n, usb_c_post_cycle_continuity, power_button_actuation_force_n, volume_button_actuation_force_n, button_travel_mm, haptic_clearance_mm, port_button_gasket_visual
  Evidence artifacts: interface-validation.json, evt-inspection-plan.json, fixture-calibration-acceptance.json
  Stop rule: Stop build on high USB insertion force, continuity failure, button force/travel outlier, haptic rub, or damaged gasket.
- PASS: `battery_install_and_enclosure_close` at `final_mechanical_close` - battery window fit, snap/screw retention, enclosure gaps, no cable pinch, and cosmetic check pass
  Required measurements: battery_window_fit_visual, cable_pinch_visual, snap_retention_n, screw_torque_ncm, gap_flush_mm, enclosure_close_photo
  Evidence artifacts: assembly-clearance.json, tolerance-stack.json, gdt-fai-results-review.json
  Stop rule: Stop build on battery interference, cable pinch, failed retention, stripped boss, or out-of-limit gap/flush.
- PASS: `final_function_cmf_and_traceability` at `final_acceptance` - display, touch, cameras, audio, USB, buttons, radio smoke, CMF visual, serial trace, and photo record pass
  Required measurements: display_touch_final_pass, front_rear_camera_final_pass, speaker_mic_earpiece_final_pass, usb_c_final_pass, button_haptic_final_pass, radio_smoke_test_pass, orange_cmf_visual_pass, unit_serial_trace_record, final_photo_record
  Evidence artifacts: visual-decision-report.json, unit-traceability-acceptance.json, cmf-release-acceptance.json
  Stop rule: Hold the unit on any functional, CMF, traceability, or final photo failure.

## Blank Or Incomplete Steps

- `incoming_supplier_part_inspection`
- `screen_adhesive_and_display_bond`
- `top_bottom_pcb_islands_and_split_flex`
- `camera_handset_and_acoustic_stack`
- `usb_buttons_haptics_and_ingress_seals`
- `battery_install_and_enclosure_close`
- `final_function_cmf_and_traceability`

## Release Rule

- Every traveler step must include build ID, unit serial, operator, observed/measured result, and explicit pass before claiming end-to-end assembly readiness.
