# E1 Phone Explode-State Collision Validation

Status: explode_collision_pass.

Engine: `world_aabb_overlap_volume_swept_along_explode_trajectory`.
Solid parts: 90. Pairs checked: 4005. Trajectory samples: 21. Virtual keepout volumes excluded: 5.

## Pass-through (overlap grows during explode)

- PASS: no part overlap grows beyond its assembled baseline.

## Residual overlap at full explode

- review: `main_pcb` vs `split_interconnect_top_flex_tail` 3.6 mm^3 still nested
- review: `main_pcb` vs `split_interconnect_bottom_flex_tail` 3.6 mm^3 still nested
- review: `battery_pouch` vs `orange_screw_boss_5` 29.106 mm^3 still nested
- review: `battery_pouch` vs `orange_screw_boss_6` 29.106 mm^3 still nested
- review: `battery_pouch` vs `orange_battery_left_rib` 91.35 mm^3 still nested
- review: `battery_pouch` vs `orange_battery_right_rib` 91.35 mm^3 still nested
- review: `usb_c_molded_drip_break_lip` vs `usb_c_internal_drain_shelf` 0.1123 mm^3 still nested
- review: `rear_camera_lens_window` vs `rear_camera_cover_glass` 25.432 mm^3 still nested
- review: `rear_camera_light_baffle_top` vs `rear_camera_cover_glass` 1.3799 mm^3 still nested
- review: `rear_camera_light_baffle_bottom` vs `rear_camera_cover_glass` 1.3799 mm^3 still nested
- review: `orange_screw_boss_3` vs `orange_battery_left_rib` 0.0562 mm^3 still nested
- review: `orange_screw_boss_4` vs `orange_battery_right_rib` 0.0562 mm^3 still nested
- review: `orange_screw_boss_5` vs `orange_battery_left_rib` 2.3625 mm^3 still nested
- review: `orange_screw_boss_6` vs `orange_battery_right_rib` 2.3625 mm^3 still nested
- review: `soc_shield_can` vs `radio_shield_can` 46.8 mm^3 still nested

## Release Rule

- No part-part overlap may grow beyond its assembled baseline anywhere on the explode trajectory (no pass-through). Residual overlaps at full explode are reported for review; same-axis stacked parts may legitimately remain nested if their assembled overlap does not grow.
