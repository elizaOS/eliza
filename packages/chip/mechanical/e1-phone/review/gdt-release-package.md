# E1 Phone GD&T Release Characteristic Package

Status: CAD-derived characteristic package ready; not a signed release drawing.

FAI template: `mechanical/e1-phone/review/gdt-fai-template.csv`

## Datums

- `A` front_cover_glass_outer_plane: Primary touch/display cosmetic plane and Z-stack reference.
- `B` device_centerline_x: Left/right symmetry reference for glass, PCB, USB-C, and camera placement.
- `C` bottom_usb_c_port_centerline: Bottom I/O datum for USB insertion, speaker grille, microphones, and lower antenna.
- `D` rear_camera_cover_glass_center: Camera lens/window datum for rear camera module and cover-glass alignment.

## Characteristics

- `CRIT-001` cover_glass_perimeter: profile to datum B/C
- `CRIT-002` usb_c_port_aperture: position to datum B/C
- `CRIT-003` side_button_plunger_faces: position to side rail and travel stop
- `CRIT-004` rear_camera_cover_glass_window: position to datum D
- `CRIT-005` screw_boss_core_pins: position to rear shell datum pattern
- `STACK-006` cover_glass_to_orange_rail_x: minimum clearance to datum B
- `STACK-007` cover_glass_to_orange_rail_y: minimum clearance to datum C
- `STACK-008` display_tft_under_cover_glass: minimum clearance to datum A
- `STACK-009` display_fpc_bend_radius: minimum clearance to datum A
- `STACK-010` usb_shell_to_aperture: minimum clearance to datum C
- `STACK-011` pcb_edge_to_enclosure: minimum clearance to datum B
- `STACK-012` rear_camera_lens_to_cover_glass: minimum clearance to datum D
- `STACK-013` nominal_z_stack_margin: minimum clearance to datum A

## Release Blockers

- Needs supplier-returned STEP and drawings before nominal dimensions are frozen.
- Needs toolmaker-approved datum scheme and CMM plan.
- Needs populated first-article inspection measurements before release.
