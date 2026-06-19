# E1 Phone Unit Traceability Acceptance

Status: blocked_no_unit_traceability_results.

This gate blocks final release until physical unit records connect serials, lots, tests, photos, and disposition.

## Traceability Cases

- PASS: `serial_marking_service_label_recess` - unit serial, 2D code scan, and photo showing mark inside service-label recess
  Required records: unit_serial, service_label_photo, two_d_code_scan, label_location_pass
  Linked evidence: service_label_recess.step, assembly-build-traveler.json
- PASS: `component_lot_linkage` - display, camera, USB-C, battery, audio, button, PCB, orange resin, and adhesive lot records
  Required records: display_lot, rear_camera_lot, front_camera_lot, usb_c_lot, battery_lot, speaker_receiver_mic_lots, button_lot, pcb_lot, orange_resin_lot, adhesive_lot
  Linked evidence: supplier-response-review.json, supplier-evidence-acceptance.json, assembly-build-traveler.json
- PASS: `evt_measurement_record_link` - completed EVT measurement set linked to the same unit serial
  Required records: evt_measurement_run_id, button_force_rows, usb_insertion_rows, screen_bond_rows, camera_alignment_rows, acoustic_rows
  Linked evidence: evt-results-review.json, fixture-calibration-acceptance.json, mechanical-lifecycle-acceptance.json
- PASS: `evt_result_disposition_link` - EVT result review disposition and operator signoff
  Required records: evt_disposition, reviewer, operator, nonconformance_ids, retest_status
  Linked evidence: evt-results-review.json, physical-process-validation-acceptance.json
- PASS: `visual_cmf_photo_record` - front/back/bottom/side photo set and orange shell visual disposition
  Required records: front_photo, back_photo, bottom_port_photo, side_button_photo, orange_cmf_disposition, visual_reviewer
  Linked evidence: visual-decision-report.json, cmf-release-acceptance.json, part-review-contact-sheet.png
- PASS: `final_function_and_rework_history` - functional smoke test, final photo record, NC IDs, and rework history
  Required records: display_touch_pass, camera_pass, audio_pass, usb_pass, button_haptic_pass, radio_smoke_pass, final_photo_artifact, nc_rework_history
  Linked evidence: assembly-build-traveler.json, process-control-plan.json, unit-traceability-acceptance.json

## Incomplete Cases

- `serial_marking_service_label_recess`
- `component_lot_linkage`
- `evt_measurement_record_link`
- `evt_result_disposition_link`
- `visual_cmf_photo_record`
- `final_function_and_rework_history`

## Release Rule

- Every released unit must have unit serial, build ID, artifact ID, reviewer, accepted disposition, component lot links, final photos, test disposition, and NC/rework history before shipment.
