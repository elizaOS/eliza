# E1 Phone Camera Validation

Status: CAD camera validation ready; supplier and optical measurements still required.

## CAD Camera Cases

- PASS: `rear_camera_cover_window_margin` target >=0.8 mm radial margin around rear AF lens
- PASS: `rear_camera_z_stack` target rear AF stack depth <=5.5 mm and >=2.0 mm battery gap
- PASS: `front_under_glass_margin` target >=1.0 mm radial module margin and <=0.8 mm cover glass for front under-glass camera
- PASS: `front_camera_earpiece_clearance` target >=1.0 mm front camera to earpiece receiver gap
- PASS: `camera_interface_strategy` target front camera under glass with black mask; rear AF camera through gasketed/baffled cover window

## Lab Measurements

- `rear_camera_lens_center_error_mm` mm fixture `evt_fixture_rear_camera_alignment_pin`
- `front_camera_under_glass_center_error_mm` mm fixture `evt_fixture_front_camera_alignment_pin`
- `rear_camera_focus_mtf50_lp_per_mm` lp/mm fixture `iso12233_chart`
- `front_camera_mtf50_lp_per_mm` lp/mm fixture `iso12233_chart_through_cover_glass`
- `front_cover_glass_color_delta_e` deltaE fixture `color_chart_lightbox`
- `rear_camera_dust_or_vignette_defects` count fixture `flat_field_capture`
- `camera_streaming_bringup_logs` pass_flag fixture `v4l2_or_android_camera_hal`

## Release Blockers

- Need supplier drawings/STEP for rear and front module optical center, FPC exit, and lens stack.
- Need rear cover-window dust gasket drawing and first-article center/MTF measurements.
- Need front under-glass capture validation through selected cover glass and black mask.
- Need V4L2 or Android Camera HAL streaming logs with selected sensor drivers and pinout.
