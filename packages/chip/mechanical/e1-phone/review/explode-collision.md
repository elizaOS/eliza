# E1 Phone Explode-State Collision Validation

Status: explode_collision_fail.

Engine: `world_aabb_overlap_volume_swept_along_explode_trajectory`.
Solid parts: 118. Pairs checked: 6903. Trajectory samples: 21. Virtual keepout volumes excluded: 5.

## Pass-through (overlap grows during explode)

- FAIL: `orange_snap_hook_8` vs `haptic_lra` grows 0.91 mm^3 (peak 0.91 mm^3 at f=0.05)

## Residual overlap at full explode

- review: `orange_side_frame` vs `split_interconnect_top_connector` 34.56 mm^3 still nested
- review: `orange_side_frame` vs `split_interconnect_bottom_connector` 34.56 mm^3 still nested
- review: `orange_side_frame` vs `split_interconnect_top_flex_tail` 4.5 mm^3 still nested
- review: `orange_side_frame` vs `split_interconnect_bottom_flex_tail` 4.5 mm^3 still nested
- review: `orange_side_frame` vs `antenna_aperture_tuner` 2.0 mm^3 still nested
- review: `battery_pouch` vs `orange_battery_left_rib` 91.35 mm^3 still nested
- review: `battery_pouch` vs `orange_battery_right_rib` 91.35 mm^3 still nested
- review: `usb_c_molded_drip_break_lip` vs `usb_c_internal_drain_shelf` 0.1123 mm^3 still nested
- review: `rear_camera_shell_aperture` vs `rear_camera_lens_window` 1.156 mm^3 still nested
- review: `rear_camera_shell_aperture` vs `rear_camera_cover_glass` 2.116 mm^3 still nested
- review: `rear_flash_shell_aperture` vs `rear_flash_led_window` 0.064 mm^3 still nested
- review: `rear_camera_lens_window` vs `rear_camera_cover_glass` 25.432 mm^3 still nested
- review: `front_camera_under_glass` vs `front_camera_black_mask_window` 0.9248 mm^3 still nested
- review: `rear_camera_light_baffle_top` vs `rear_camera_cover_glass` 1.3799 mm^3 still nested
- review: `rear_camera_light_baffle_bottom` vs `rear_camera_cover_glass` 1.3799 mm^3 still nested
- review: `orange_screw_boss_1` vs `orange_corner_rib_1` 4.536 mm^3 still nested
- review: `orange_screw_boss_1` vs `orange_corner_rib_1_leg` 4.536 mm^3 still nested
- review: `orange_screw_boss_2` vs `orange_corner_rib_2` 4.536 mm^3 still nested
- review: `orange_screw_boss_2` vs `orange_corner_rib_2_leg` 4.536 mm^3 still nested
- review: `orange_screw_boss_3` vs `orange_corner_rib_3` 4.536 mm^3 still nested
- review: `orange_screw_boss_3` vs `orange_corner_rib_3_leg` 4.536 mm^3 still nested
- review: `orange_screw_boss_4` vs `orange_corner_rib_4` 4.536 mm^3 still nested
- review: `orange_screw_boss_4` vs `orange_corner_rib_4_leg` 4.536 mm^3 still nested
- review: `orange_corner_rib_1` vs `orange_corner_rib_1_leg` 1.944 mm^3 still nested
- review: `orange_corner_rib_2` vs `orange_corner_rib_2_leg` 1.944 mm^3 still nested
- review: `orange_corner_rib_3` vs `orange_corner_rib_3_leg` 1.944 mm^3 still nested
- review: `orange_corner_rib_4` vs `orange_corner_rib_4_leg` 1.944 mm^3 still nested
- review: `soc_shield_can` vs `radio_shield_can` 46.8 mm^3 still nested

## Release Rule

- No part-part overlap may grow beyond its assembled baseline anywhere on the explode trajectory (no pass-through). Residual overlaps at full explode are reported for review; same-axis stacked parts may legitimately remain nested if their assembled overlap does not grow.
