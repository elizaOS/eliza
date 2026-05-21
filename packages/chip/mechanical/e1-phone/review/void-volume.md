# e1-phone internal void volume

evidence_class: `cad_estimate_for_evt_planning, not_measured_hardware`

- Cavity volume: **113.05 cm3** (Z -4.70..5.20 mm, inner XY 75.7 x 151.3 mm, r=6.35)
- Filled (component solids): **71.65 cm3**
- Void: **41.40 cm3** = **36.6%** of cavity

## Void by region

| region | Z band (mm) | void cm3 | note |
|---|---|---|---|
| front_display_gap | 5.02..5.2 | 2.0072 | between display module top and cover-glass inner face |
| mid_pcb_band | -2.5..5.02 | 25.5044 | around-PCB / battery front margins |
| back_band | -4.7..-2.5 | 14.2453 | battery swell void + camera/flash burial + bottom-edge margins |

## Top filled parts

| part | role | cm3 | Z (mm) |
|---|---|---|---|
| battery_pouch | battery | 31.1808 | -4.15..1.45 |
| display_lcm | screen | 30.9936 | 1.63..5.02 |
| main_pcb | PCB | 2.2528 | -2.5..-1.7 |
| battery_back_void_foam_pad | battery support | 0.864 | -4.75..-4.57 |
| cellular_top_antenna_keepout | RF keepout | 0.744 | -2.1..-0.1 |
| cellular_bottom_antenna_keepout | RF keepout | 0.744 | -2.1..-0.1 |
| sim_tray_keepout | service | 0.638 | -1.8..0.2 |
| bottom_speaker_module | audio | 0.5775 | -4.1..-0.6 |
| bottom_speaker_acoustic_chamber | audio | 0.5148 | -5.2..-3.0 |
| rear_camera_module | camera | 0.51 | -4.3..0.8 |
| radio_shield_can | EMI shield | 0.432 | -1.5..-0.3 |
| soc_shield_can | EMI shield | 0.3456 | -1.5..-0.3 |
| wifi_bt_side_antenna_keepout | RF keepout | 0.34 | -2.1..-0.1 |
| usb_c_receptacle | I/O | 0.2266 | -3.225..0.025 |
| earpiece_receiver | audio | 0.18 | -0.25..2.25 |
| haptic_lra | haptics | 0.18 | -4.45..-1.95 |
| front_camera_module | camera | 0.1352 | -0.6..2.6 |
| pmic_shield_can | EMI shield | 0.121 | -1.5..-0.4 |
| display_fpc_connector | connector | 0.0699 | -1.575..-0.425 |
| display_fpc_bend_keepout | connector | 0.066 | 0.15..0.45 |
| sim_tray_outline | service | 0.0576 | -2.8..1.2 |
| volume_button_cap | button | 0.0462 | -0.95..0.15 |
| split_interconnect_side_flex | split-board interconnect | 0.038 | -1.94..-1.76 |
| split_interconnect_top_connector | split-board interconnect | 0.0346 | -1.7..-0.8 |
| split_interconnect_bottom_connector | split-board interconnect | 0.0346 | -1.7..-0.8 |
