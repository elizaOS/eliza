# E1 Phone Fixture Calibration Acceptance

Status: blocked_no_fixture_calibration_results.

This gate blocks physical validation claims until every EVT fixture has traceable calibration evidence.

## Calibration Cases

- PASS: `button_force_probe_load_cell_and_travel` using `evt_fixture_button_force_probe` - force <= +/-0.05 N and travel <= +/-0.02 mm
  Controlled measurements: power_button_actuation_force, power_button_travel, volume_button_actuation_force
  Required standards: load_cell_weight_certificate, dial_indicator_block_certificate, probe_axis_alignment_photo
- PASS: `usb_c_insertion_gauge_axis_and_force` using `evt_fixture_usb_c_insertion_gauge` - axis <= 0.10 mm TIR and force <= +/-0.5 N
  Controlled measurements: usb_c_insertion_force_no_rub
  Required standards: usb_c_plug_gauge_certificate, port_axis_alignment_record, force_gauge_certificate
- PASS: `screen_bond_clamp_flatness_and_gap` using `evt_fixture_screen_bond_clamp_frame` - flatness <= 0.05 mm and bond gap <= +/-0.02 mm
  Controlled measurements: screen_adhesive_compression, display_fpc_bend_radius
  Required standards: granite_plate_certificate, feeler_gauge_certificate, compression_witness_shim_record
- PASS: `rear_camera_alignment_pin_datum` using `evt_fixture_rear_camera_alignment_pin` - pin center <= +/-0.03 mm and pin diameter <= +/-0.01 mm
  Controlled measurements: rear_camera_lens_center_error
  Required standards: camera_window_datum_drawing, cmm_or_comparator_report, pin_diameter_certificate
- PASS: `front_camera_alignment_pin_datum` using `evt_fixture_front_camera_alignment_pin` - pin center <= +/-0.03 mm and pin diameter <= +/-0.01 mm
  Controlled measurements: front_camera_under_glass_center_error
  Required standards: front_glass_aperture_datum_drawing, cmm_or_comparator_report, pin_diameter_certificate
- PASS: `bottom_acoustic_leak_mask_seal` using `evt_fixture_bottom_acoustic_leak_mask` - seal leak delta <= 0.5 dB against reference
  Controlled measurements: bottom_audio_leak_delta
  Required standards: flatness_plate_certificate, leak_reference_orifice_certificate, acoustic_calibrator_certificate
- PASS: `earpiece_acoustic_leak_mask_seal` using `evt_fixture_earpiece_leak_mask` - seal leak delta <= 0.5 dB against reference
  Controlled measurements: handset_receiver_leak_delta
  Required standards: flatness_plate_certificate, leak_reference_orifice_certificate, acoustic_calibrator_certificate

## Incomplete Cases

- `button_force_probe_load_cell_and_travel`
- `usb_c_insertion_gauge_axis_and_force`
- `screen_bond_clamp_flatness_and_gap`
- `rear_camera_alignment_pin_datum`
- `front_camera_alignment_pin_datum`
- `bottom_acoustic_leak_mask_seal`
- `earpiece_acoustic_leak_mask_seal`

## Release Rule

- Every EVT fixture and gauge must have traceable calibration standard, calibrated operator, date, as-left error, certificate ID, and explicit pass before physical test rows can support release.
