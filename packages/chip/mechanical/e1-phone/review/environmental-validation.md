# E1 Phone Environmental Validation

Status: CAD environmental validation ready; physical and regulatory evidence still required.

## CAD Environmental Cases

- PASS: `thermal_spreader_and_skin_temp_plan` domain `thermal` target shield cans present and CAD mass below target for thermal inertia; lab skin temperature <= target
- PASS: `rf_keepout_and_prescan_plan` domain `rf` target antenna keepouts present; chamber desense and SAR pre-scan required before RF release
- PASS: `drop_retention_and_corner_energy_plan` domain `drop` target >=1 m EVT drop plan with rounded orange PC+ABS corners, screw bosses, snap hooks, and bonded screen
- PASS: `ingress_path_and_gasket_plan` domain `ingress` target IP54 design-intent path review; open ports need membranes or lab-accepted splash/dust result

## Lab Measurements

- `max_skin_temp_video_call_c` C domain `thermal` fixture `thermal_chamber_or_skin_temp_probe`
- `soc_shield_can_peak_temp_c` C domain `thermal` fixture `thermocouple_on_soc_shield`
- `cellular_desense_delta_db` dB domain `rf` fixture `rf_chamber_desense_prescan`
- `wifi_bt_desense_delta_db` dB domain `rf` fixture `rf_chamber_desense_prescan`
- `sar_prescan_w_per_kg_1g` W/kg domain `rf` fixture `accredited_sar_prescan`
- `drop_1m_functional_failures` count domain `drop` fixture `evt_corner_edge_face_drop`
- `drop_1m_crack_or_latch_release` count domain `drop` fixture `evt_visual_and_latch_inspection`
- `ip54_dust_ingress_functional_failures` count domain `ingress` fixture `dust_ingress_screen_usb_audio_inspection`
- `ip54_splash_ingress_functional_failures` count domain `ingress` fixture `splash_ingress_screen_usb_audio_inspection`

## Release Blockers

- Need routed board power map and thermal measurements with real enclosure resin.
- Need RF chamber desense data, antenna tuning, and SAR pre-scan with final antennas.
- Need 1 m corner/edge/face drop results on EVT molded samples.
- Need dust/splash ingress results or explicit product decision to drop IP54 claim.
