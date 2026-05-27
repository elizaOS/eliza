# E1 Phone Routed-Board Release Acceptance Matrix

Date: 2026-05-22

Status: `blocked_fail_closed_routed_board_release_acceptance_not_met`

Fail-closed acceptance matrix generated from routed-board source inventories. This is not a routed PCB, DRC/ERC result, SI/PI/RF signoff, manufacturing package, routed STEP, enclosure release, factory release, or end-to-end phone readiness claim.

## Summary

| Metric | Value |
| --- | ---: |
| `route_domain_count` | `7` |
| `domains_with_missing_exact_nets` | `0` |
| `domains_with_missing_production_outputs` | `0` |
| `required_output_path_count` | `46` |
| `missing_required_output_path_count` | `0` |
| `candidate_present_blocked_required_output_path_count` | `37` |
| `truly_missing_required_output_path_count` | `0` |
| `candidate_step_size_bytes` | `32970696` |
| `candidate_step_component_model_count` | `89` |
| `candidate_step_pinout_bound_model_count` | `22` |
| `candidate_step_cad_connection_count` | `24` |
| `candidate_step_cad_connection_terminal_marker_count` | `48` |
| `candidate_step_cad_connection_terminal_pair_count` | `24` |
| `validation_evidence_category_count` | `6` |
| `missing_validation_evidence_category_count` | `0` |
| `release_state` | `blocked_fail_closed` |
| `acceptance_allowed` | `False` |

## Local Routed Candidate Context

| Item | Value |
| --- | ---: |
| Status | `blocked_local_candidate_outputs_not_release` |
| Release credit | `False` |
| STEP bytes | `32970696` |
| Component envelopes | `89` |
| Pad/contact visuals | `1452` |
| Route segment visuals | `306` |
| Via visuals | `24` |
| CAD connections passing | `24` |
| CAD endpoint terminal markers | `48` |
| CAD terminal pairs passing | `24` |
| CAD connection STEP parts | `72` |
| CAD connection STEP part sets passing | `24` |
| CAD represented nets | `112` |
| CAD connection records | `24` |
| CAD represented net list entries | `112` |
| CAD represented nets match routed nets | `True` |
| CAD visual route span mm | `397.8` |
| CAD controlled-impedance connections | `14` |
| CAD controlled-impedance requirements defined | `24` |
| CAD bend-radius requirements defined | `24` |
| CAD supplier-release-required connections | `24` |
| Component model rows | `89` |
| Component pad visuals | `1452` |
| Electrical pads represented | `1441` |
| Mechanical pads represented | `7` |
| Pinout-bound model rows | `22` |
| Support-pattern model rows | `67` |
| Models with terminal contracts or no electrical pads | `89` |
| Non-signal pad contracts | `7` |
| Models with non-signal pad contracts | `6` |
| NPTH mechanical feature contracts | `4` |
| Models with NPTH mechanical feature contracts | `4` |
| Local per-reference model records | `89` |
| Directory pinout-bound model records | `22` |
| Directory support-pattern model records | `67` |
| Directory records with terminal contracts | `85` |
| Directory terminal contracts | `1441` |
| Directory non-signal pad contracts | `7` |
| Directory NPTH mechanical feature contracts | `4` |
| Directory records with NPTH mechanical contracts | `4` |
| Directory pinout records terminal-bound | `True` |
| Directory support records provenance-bound | `True` |
| Directory terminal contracts match visuals | `True` |
| Directory non-signal contracts match visuals | `True` |
| Directory NPTH contracts match footprints | `True` |
| Component 3D binding rows | `89` |
| Component 3D binding local STEP files | `89` |
| Component 3D binding supplier intake statuses | `{'not_applicable_board_level_support_pattern': 42, 'present_local_surrogate_step_not_supplier_approved': 47}` |
| Component 3D binding release credit | `False` |
| Supplier-approved model rows | `0` |

Local routed-output candidate has routed development tracks, visible component envelopes, electrical terminal contracts, non-signal pad contracts, and CAD connection markers, but still lacks supplier-approved STEP/B-rep models, production DRC/ERC/SI/PI/RF, fabricator/assembler approval, and first-article evidence.

## Route Domains

| Domain | Missing nets | Missing outputs | Next unblock action |
| --- | ---: | ---: | --- |
| `usb_c_power_sidekey_spine` | 0 | 0 | USB_DP_DN concept Manhattan path is 122.5 mm, 32.5 mm over the current 90 mm target |
| `display_touch_mipi_dsi` | 0 | 0 | selected display connector land pattern, pinout, STEP, FPC bend, and stiffener data are not supplier signed |
| `front_rear_camera_mipi_csi` | 0 | 0 | camera module FPC pinouts, connector footprints, lens-axis datums, and STEP models are missing |
| `cellular_wifi_bt_rf_host` | 0 | 0 | cellular and Wi-Fi module pad maps, reference layouts, exact SKU constraints, RF keepouts, and STEP models are missing |
| `compute_memory_storage_escape` | 0 | 0 | SoC, LPDDR, UFS, PMIC pin maps and layout guides are not captured as release footprints |
| `split_interconnect_and_audio_haptics` | 0 | 0 | exact flex or board-to-board connector family, pinout, stack height, and STEP are missing |
| `factory_test_fiducials_and_manufacturing_coupons` | 0 | 0 | no routed probe coordinates, local fiducials, panel rails, tooling holes, or coupon drawings exist |

## Required Acceptance Evidence

| Evidence | Present | Missing artifacts | Acceptance rule |
| --- | --- | ---: | --- |
| `drc_erc` | `True` | 0 | clean_or_every_violation_has_signed_release_waiver |
| `signal_integrity` | `True` | 0 | post_route_length_skew_impedance_return_path_and_channel_checks_present |
| `power_integrity` | `True` | 0 | high_current_loops_current_density_decoupling_return_path_and_thermal_limits_closed |
| `rf_validation` | `True` | 0 | matching_conducted_access_coexistence_gnss_desense_and_sar_prescan_ready |
| `enclosure_validation` | `True` | 0 | routed_step_with_supplier_models_passes_clearance_against_display_battery_usb_buttons_cameras_antennas_acoustics_and_split_interconnect |
| `component_3d_binding_gap_matrix` | `True` | 0 | every_board_footprint_has_fail_closed_component_3d_binding_supplier_step_intake_status_local_step_locator_and_release_credit_false |

## Fail-Closed Claims

Acceptance remains blocked. Forbidden claims include:

- `carrier_ready`
- `drc_clean`
- `enclosure_ready`
- `end_to_end_phone_ready`
- `erc_clean`
- `fabrication_ready`
- `factory_ready`
- `factory_test_ready`
- `manufacturing_coupons_ready`
- `manufacturing_outputs_ready`
- `power_integrity_closed`
- `power_thermal_ready`
- `production_ready`
- `rf_ready`
- `route_execution_ready`
- `route_feasible`
- `routed_pcb_ready`
- `routed_release_ready`
- `routed_step_ready`
- `si_pi_closed`
- `test_access_ready`
- `trial_route_ready`
