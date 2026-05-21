# E1 Phone Tolerance Stack And Datum Plan

Status: CAD-derived EVT0 tolerance stack pass; not a controlled release drawing.

## Datums

- `A` front_cover_glass_outer_plane: Primary touch/display cosmetic plane and Z-stack reference.
- `B` device_centerline_x: Left/right symmetry reference for glass, PCB, USB-C, and camera placement.
- `C` bottom_usb_c_port_centerline: Bottom I/O datum for USB insertion, speaker grille, microphones, and lower antenna.
- `D` rear_camera_cover_glass_center: Camera lens/window datum for rear camera module and cover-glass alignment.

## Stack Checks

- PASS: `cover_glass_to_orange_rail_x` nominal 0.45 mm, minimum 0.3 mm
- PASS: `cover_glass_to_orange_rail_y` nominal 0.915 mm, minimum 0.3 mm
- PASS: `display_tft_under_cover_glass` nominal 3.16 mm, minimum 0.5 mm
- PASS: `display_fpc_bend_radius` nominal 1.0 mm, minimum 1.0 mm
- PASS: `usb_shell_to_aperture` nominal 0.175 mm, minimum 0.15 mm
- PASS: `pcb_edge_to_enclosure` nominal 7.0 mm, minimum 2.5 mm
- PASS: `rear_camera_lens_to_cover_glass` nominal 1.2 mm, minimum 0.8 mm
- PASS: `nominal_z_stack_margin` nominal 2.62 mm, minimum 1.0 mm

## Drawing Controls To Add Before Release

- `cover_glass_perimeter`: profile to datum B/C, EVT0 tolerance +/-0.25 mm
- `usb_c_port_aperture`: position to datum B/C, EVT0 tolerance +/-0.15 mm
- `side_button_plunger_faces`: position to side rail and travel stop, EVT0 tolerance +/-0.2 mm
- `rear_camera_cover_glass_window`: position to datum D, EVT0 tolerance +/-0.15 mm
- `screw_boss_core_pins`: position to rear shell datum pattern, EVT0 tolerance +/-0.2 mm
