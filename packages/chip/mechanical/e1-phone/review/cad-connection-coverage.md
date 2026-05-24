# E1 Phone CAD Connection Coverage

Status: cad_connection_markers_complete_not_release.

## Connections

- PASS: `display_touch_fpc` uses `display_fpc_tail` from `display_fpc_connector` to `display_lcm`; nets=14, terminals=`display_touch_fpc_from_terminal`/`display_touch_fpc_to_terminal`, span=10.0 mm, endpoint_distance=64.869 mm
- PASS: `rear_camera_csi_fpc` uses `rear_camera_fpc_tail` from `main_pcb` to `rear_camera_module`; nets=13, terminals=`rear_camera_csi_fpc_from_terminal`/`rear_camera_csi_fpc_to_terminal`, span=12.0 mm, endpoint_distance=61.498 mm
- PASS: `front_camera_csi_fpc` uses `front_camera_fpc_tail` from `main_pcb` to `front_camera_module`; nets=9, terminals=`front_camera_csi_fpc_from_terminal`/`front_camera_csi_fpc_to_terminal`, span=9.0 mm, endpoint_distance=70.48 mm
- PASS: `side_key_flex` uses `side_key_flex_tail` from `main_pcb` to `power_button_cap`; nets=3, terminals=`side_key_flex_from_terminal`/`side_key_flex_to_terminal`, span=28.0 mm, endpoint_distance=44.352 mm
- PASS: `battery_lead_flex` uses `battery_connector_lead_flex` from `battery_pouch` to `main_pcb`; nets=4, terminals=`battery_lead_flex_from_terminal`/`battery_lead_flex_to_terminal`, span=8.0 mm, endpoint_distance=7.04 mm
- PASS: `usb_c_escape_tail` uses `usb_c_power_data_escape_tail` from `usb_c_receptacle` to `main_pcb`; nets=5, terminals=`usb_c_escape_tail_from_terminal`/`usb_c_escape_tail_to_terminal`, span=18.0 mm, endpoint_distance=72.702 mm
- PASS: `bottom_speaker_lead_pair` uses `bottom_speaker_lead_pair` from `main_pcb` to `bottom_speaker_module`; nets=2, terminals=`bottom_speaker_lead_pair_from_terminal`/`bottom_speaker_lead_pair_to_terminal`, span=10.0 mm, endpoint_distance=66.429 mm
- PASS: `bottom_microphone_flex` uses `bottom_microphone_flex_leads` from `main_pcb` to `bottom_mic`; nets=2, terminals=`bottom_microphone_flex_from_terminal`/`bottom_microphone_flex_to_terminal`, span=8.0 mm, endpoint_distance=70.927 mm
- PASS: `top_microphone_flex` uses `top_microphone_flex_tail` from `main_pcb` to `top_mic`; nets=2, terminals=`top_microphone_flex_from_terminal`/`top_microphone_flex_to_terminal`, span=18.0 mm, endpoint_distance=70.927 mm
- PASS: `earpiece_receiver_lead_flex` uses `earpiece_receiver_lead_flex` from `main_pcb` to `earpiece_receiver`; nets=2, terminals=`earpiece_receiver_lead_flex_from_terminal`/`earpiece_receiver_lead_flex_to_terminal`, span=14.0 mm, endpoint_distance=68.87 mm
- PASS: `haptic_flex` uses `haptic_flex_tail` from `main_pcb` to `haptic_lra`; nets=1, terminals=`haptic_flex_from_terminal`/`haptic_flex_to_terminal`, span=12.0 mm, endpoint_distance=56.546 mm
- PASS: `sim_esim_signal_flex` uses `sim_esim_signal_flex_marker` from `main_pcb` to `sim_tray_keepout`; nets=9, terminals=`sim_esim_signal_flex_from_terminal`/`sim_esim_signal_flex_to_terminal`, span=9.0 mm, endpoint_distance=36.564 mm
- PASS: `nfc_loop_antenna_flex` uses `nfc_loop_antenna_flex_marker` from `nfc_controller_package_marker` to `nfc_loop_match_marker`; nets=4, terminals=`nfc_loop_antenna_flex_from_terminal`/`nfc_loop_antenna_flex_to_terminal`, span=6.0 mm, endpoint_distance=28.284 mm
- PASS: `compute_som_sodimm_carrier` uses `compute_som_sodimm_connector` from `main_pcb` to `compute_som_daughterboard_keepout`; nets=9, terminals=`compute_som_sodimm_carrier_from_terminal`/`compute_som_sodimm_carrier_to_terminal`, span=65.0 mm, endpoint_distance=45.036 mm
- PASS: `cellular_main_rf_feed` uses `cellular_rf_feed_development_envelope` from `cellular_lga_module_keepout` to `cellular_top_antenna_keepout`; nets=1, terminals=`cellular_main_rf_feed_from_terminal`/`cellular_main_rf_feed_to_terminal`, span=15.0 mm, endpoint_distance=30.621 mm
- PASS: `cellular_diversity_rf_feed` uses `cellular_div_rf_feed_development_envelope` from `cellular_lga_module_keepout` to `cellular_bottom_antenna_keepout`; nets=1, terminals=`cellular_diversity_rf_feed_from_terminal`/`cellular_diversity_rf_feed_to_terminal`, span=12.0 mm, endpoint_distance=117.429 mm
- PASS: `cellular_antenna_aperture_tuner` uses `antenna_aperture_tuner` from `cellular_lga_module_keepout` to `cellular_bottom_antenna_keepout`; nets=2, terminals=`cellular_antenna_aperture_tuner_from_terminal`/`cellular_antenna_aperture_tuner_to_terminal`, span=2.0 mm, endpoint_distance=117.429 mm
- PASS: `cellular_gnss_rf_feed` uses `cellular_gnss_rf_feed_development_envelope` from `cellular_lga_module_keepout` to `gnss_lna_package_marker`; nets=1, terminals=`cellular_gnss_rf_feed_from_terminal`/`cellular_gnss_rf_feed_to_terminal`, span=10.0 mm, endpoint_distance=22.739 mm
- PASS: `wifi_bt_rf0_feed` uses `wifi_bt_rf_feed_development_envelope` from `wifi_bt_module_keepout` to `wifi_bt_side_antenna_keepout`; nets=1, terminals=`wifi_bt_rf0_feed_from_terminal`/`wifi_bt_rf0_feed_to_terminal`, span=10.0 mm, endpoint_distance=1.418 mm
- PASS: `wifi_bt_rf1_feed` uses `wifi_bt_rf1_feed_development_envelope` from `wifi_bt_module_keepout` to `wifi_bt_side_antenna_keepout`; nets=1, terminals=`wifi_bt_rf1_feed_from_terminal`/`wifi_bt_rf1_feed_to_terminal`, span=10.0 mm, endpoint_distance=1.418 mm
- PASS: `split_interconnect_side_flex` uses `split_interconnect_side_flex` from `split_interconnect_top_connector` to `split_interconnect_bottom_connector`; nets=8, terminals=`split_interconnect_side_flex_from_terminal`/`split_interconnect_side_flex_to_terminal`, span=88.0 mm, endpoint_distance=90.0 mm
