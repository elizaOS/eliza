# E1 Phone Process Control Plan

Status: blocked_no_process_control_results.

This gate keeps station controls fail-closed until real line records are populated.

## Controls

- PASS: `incoming_supplier_identity_control` at `incoming_quality` - supplier drawing, STEP, sample, lot, and dimensional identity match the selected phone CAD baseline
  Required outputs: supplier_lot_id, drawing_revision, step_model_revision, sample_identity_pass, critical_dimension_pass
  Linked evidence: supplier-response-review.json, unit-traceability-acceptance.json, gdt-release-package.json
  Sample plan: 100% first lot, AQL after supplier lock
  Stop rule: quarantine lot and block build if any supplier drawing, STEP, or sample identity is missing
- PASS: `display_bond_control` at `display_bond` - cover glass position, adhesive compression, FPC bend radius, luminance, and touch grid pass
  Required outputs: cover_glass_xy_mm, adhesive_compression_mm, fpc_bend_radius_mm, luminance_cd_m2, touch_grid_pass
  Linked evidence: display-validation.json, display-results-review.json, evt-inspection-plan.json
  Sample plan: 100% EVT and first production lot
  Stop rule: stop line on screen lift, FPC overbend, touch-grid failure, or luminance outlier
- PASS: `pcb_flex_mating_control` at `pcb_flex_integration` - top and bottom PCB islands seat without battery window clash and split flex continuity passes
  Required outputs: top_connector_seated, bottom_connector_seated, split_flex_continuity_ohm, battery_clearance_mm, keepout_overlay_pass
  Linked evidence: assembly-clearance.json, interface-validation.json, assembly-build-traveler.json
  Sample plan: 100% until routed PCB and connector supplier lock
  Stop rule: stop build if connector seating, flex continuity, or battery clearance fails
- PASS: `camera_audio_stack_control` at `optical_audio_stack` - rear/front camera alignment, dust seal, speaker/mic/earpiece leakage, and streaming/audio checks pass
  Required outputs: rear_camera_center_offset_mm, front_camera_center_offset_mm, dust_image_pass, audio_loopback_pass, leak_db
  Linked evidence: camera-validation.json, camera-results-review.json, acoustic-validation.json, acoustic-results-review.json
  Sample plan: 100% EVT, then station SPC after fixture correlation
  Stop rule: stop line on camera center shift, dust, acoustic leak, blocked mesh, or audio loopback failure
- PASS: `usb_buttons_haptics_control` at `side_bottom_io` - USB-C insertion, button force/travel, haptic clearance, and port/button seal integrity pass
  Required outputs: usb_insertion_force_n, usb_continuity_pass, power_button_force_n, volume_button_force_n, button_travel_mm, gasket_visual_pass
  Linked evidence: interface-validation.json, evt-inspection-plan.json, assembly-build-traveler.json
  Sample plan: 100% EVT and 100% first production lot
  Stop rule: stop build on high insertion force, post-cycle continuity failure, button force outlier, or damaged gasket
- PASS: `enclosure_close_control` at `final_mechanical_close` - battery fits without cable pinch, orange enclosure closes, snap/screw retention and gap/flush pass
  Required outputs: battery_fit_pass, cable_pinch_visual_pass, snap_retention_n, screw_torque_ncm, gap_flush_mm
  Linked evidence: assembly-clearance.json, tolerance-stack.json, gdt-fai-results-review.json
  Sample plan: 100% EVT and first production lot
  Stop rule: stop build on battery interference, cable pinch, failed retention, or out-of-limit gap/flush
- PASS: `final_function_cmf_traceability_control` at `final_acceptance` - full function, CMF, serial traceability, and final photo evidence pass before shipment
  Required outputs: function_smoke_pass, cmf_visual_pass, serial_scan_pass, final_photo_artifact, rework_history_closed
  Linked evidence: assembly-build-traveler.json, unit-traceability-acceptance.json, visual-decision-report.json
  Sample plan: 100% all builds
  Stop rule: hold unit on function failure, CMF nonconformance, missing serial trace, or missing final photo

## Incomplete Controls

- `incoming_supplier_identity_control`
- `display_bond_control`
- `pcb_flex_mating_control`
- `camera_audio_stack_control`
- `usb_buttons_haptics_control`
- `enclosure_close_control`
- `final_function_cmf_traceability_control`

## Release Rule

- Every process control must name the build, station, operator, calibrated gauge, observed result, and explicit pass before assembly line readiness can be claimed.
