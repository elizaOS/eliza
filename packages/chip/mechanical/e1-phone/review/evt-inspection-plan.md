# E1 Phone EVT Inspection Plan

Status: inspection plan ready; results template is blank and does not prove physical validation.

Results template: `mechanical/e1-phone/review/evt-inspection-results-template.csv`

## Measurements

- `power_button_actuation_force`: fixture `evt_fixture_button_force_probe`, n=10, N limits 1.2 to 2.2
- `power_button_travel`: fixture `evt_fixture_button_force_probe`, n=10, mm limits 0.25 to 0.55
- `volume_button_actuation_force`: fixture `evt_fixture_button_force_probe`, n=10, N limits 1.2 to 2.2
- `usb_c_insertion_force_no_rub`: fixture `evt_fixture_usb_c_insertion_gauge`, n=5, N limits 0.0 to 35.0
- `screen_adhesive_compression`: fixture `evt_fixture_screen_bond_clamp_frame`, n=5, mm limits 0.03 to 0.08
- `display_fpc_bend_radius`: fixture `evt_fixture_screen_bond_clamp_frame`, n=5, mm limits >= 1.0
- `rear_camera_lens_center_error`: fixture `evt_fixture_rear_camera_alignment_pin`, n=5, mm limits 0.0 to 0.25
- `front_camera_under_glass_center_error`: fixture `evt_fixture_front_camera_alignment_pin`, n=5, mm limits 0.0 to 0.3
- `bottom_audio_leak_delta`: fixture `evt_fixture_bottom_acoustic_leak_mask`, n=5, dB limits 0.0 to 3.0
- `handset_receiver_leak_delta`: fixture `evt_fixture_earpiece_leak_mask`, n=5, dB limits 0.0 to 3.0

## Release Rule

- Every measurement row must be populated for each EVT sample and pass before claiming physical interface validation.
