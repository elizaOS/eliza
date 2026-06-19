# E1 Phone Display Validation

Status: CAD display validation ready; supplier and physical bring-up evidence still required.

## CAD Display Cases

- PASS: `display_module_envelope_fit` target >=0.3 mm nominal CTP-to-orange-body margin
- PASS: `tft_under_cover_glass` target >=0.5 mm TFT-to-cover-glass margin
- PASS: `adhesive_bond_geometry` target four-sided adhesive, 1.0 mm nominal width, 0.03-0.08 mm compression
- PASS: `display_fpc_bend_and_connector` target FPC connector and keepout present, bend radius >=1.0 mm
- PASS: `screen_interface_validation` target screen interface validation pass

## Lab Measurements

- `display_bond_peel_n_per_mm` N/mm fixture `screen_bond_peel_fixture`
- `screen_adhesive_compression_mm` mm fixture `evt_fixture_screen_bond_clamp_frame`
- `display_fpc_bend_radius_mm` mm fixture `evt_fixture_screen_bond_clamp_frame`
- `display_luminance_cd_m2` cd/m2 fixture `display_colorimeter`
- `touch_grid_dead_zones` count fixture `touch_grid_test`
- `display_dsi_bringup_logs` pass_flag fixture `drm_kms_or_android_surfaceflinger`
- `screen_drop_lift_or_glass_crack` count fixture `evt_drop_and_visual_inspection`

## Release Blockers

- Need supplier 2D/STEP drawing for module outline, FPC exit, connector datum, and touch stack.
- Need bonded-sample peel/compression and FPC bend measurements.
- Need DRM/KMS or Android SurfaceFlinger display bring-up logs.
- Need touch grid, luminance, and drop/lift validation on EVT samples.
