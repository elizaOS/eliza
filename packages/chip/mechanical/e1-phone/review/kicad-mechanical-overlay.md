# E1 Phone KiCad Mechanical Overlay Intake

Status: cad_kicad_mechanical_overlay_synced.

This CAD-side review verifies that KiCad concept keepouts remain synchronized with modeled mechanical features.

## Keepout Projection

- PASS: `battery_window` best gap 0.0 mm, limit 0.25 mm
- PASS: `usb_c_shell_capture` best gap 3.4 mm, limit 5.0 mm
- PASS: `display_fpc_bend_keepout` best gap 20.4 mm, limit 24.0 mm
- PASS: `side_key_actuator_keepout` best gap 10.55 mm, limit 12.0 mm
- PASS: `rear_camera_z_keepout` best gap 0.0 mm, limit 2.0 mm
- PASS: `front_camera_earpiece_keepout` best gap 1.55 mm, limit 6.0 mm
- PASS: `haptic_lra_keepout` best gap 3.5 mm, limit 4.0 mm
- PASS: `sim_tray_keepout` best gap 1.0 mm, limit 2.0 mm
- PASS: `top_antenna_keepout` best gap 5.4 mm, limit 8.0 mm
- PASS: `bottom_antenna_keepout` best gap 5.4 mm, limit 8.0 mm
- PASS: `wifi_bt_side_antenna_keepout` best gap 7.5 mm, limit 8.0 mm

## PCB Tokens

- PASS: `MECH_KEEP_USB_C_CAPTURE`
- PASS: `MECH_KEEP_SIDE_KEY_ACTUATOR`
- PASS: `MECH_KEEP_DISPLAY_FPC`
- PASS: `MECH_KEEP_HAPTIC_LRA`
- PASS: `MECH_KEEP_SIM_TRAY`
- PASS: `MECH_KEEP_RF_TOP`
- PASS: `MECH_KEEP_RF_BOTTOM`

## Release Blockers

- Promote Dwgs.User concept rectangles into actual KiCad keepout/courtyard rules before routed release.
- Re-run this overlay intake after any CAD envelope, battery, USB-C, display FPC, side-key, camera, RF, haptic, or service-tray move.
- Replace overlay proximity checks with routed board STEP collision checks once production footprints and 3D models exist.
