# E1 Phone Ingress Path Review

Status: cad_ingress_path_review_ready.

Target: IP54 design intent only.

## Modeled Paths

- PASS: `display_glass_perimeter` seal stack screen_adhesive_top, screen_adhesive_bottom, screen_adhesive_left, screen_adhesive_right
- PASS: `bottom_speaker_grille` seal stack bottom_speaker_dust_mesh, bottom_speaker_acoustic_chamber
- PASS: `bottom_microphone_ports` seal stack bottom_microphone_mesh_1, bottom_microphone_mesh_2
- PASS: `top_microphone_port` seal stack top_microphone_mesh
- PASS: `handset_earpiece_slot` seal stack earpiece_gasket, handset_acoustic_mesh
- PASS: `usb_c_bottom_aperture` seal stack usb_c_external_aperture, usb_c_perimeter_gasket_top, usb_c_perimeter_gasket_bottom, usb_c_perimeter_gasket_left, usb_c_perimeter_gasket_right, usb_c_molded_drip_break_lip, usb_c_internal_drain_shelf, orange_usb_reinforcement_saddle
- PASS: `rear_camera_window` seal stack rear_camera_cover_glass, rear_camera_lens_window
- PASS: `side_button_rails` seal stack power_button_cap, power_button_elastomer_gasket, power_button_labyrinth_upper_rail, power_button_labyrinth_lower_rail, volume_button_cap, volume_button_elastomer_gasket, volume_button_labyrinth_upper_rail, volume_button_labyrinth_lower_rail

## Acoustic Mesh Overhang

- PASS: `bottom_speaker_mesh_overhang` minimum overhang 0.4 mm
- PASS: `bottom_microphone_mesh_1_overhang` minimum overhang 0.25 mm
- PASS: `bottom_microphone_mesh_2_overhang` minimum overhang 0.25 mm
- PASS: `top_microphone_mesh_overhang` minimum overhang 0.25 mm
- PASS: `handset_mesh_overhang` minimum overhang 0.75 mm

## Open Product Decisions

- USB-C gasket/drip geometry is modeled, but an IP claim still needs supplier connector detail and splash/retention evidence.
- Side-button gasket/labyrinth geometry is modeled, but needs supplier material, compression-set, and splash-test evidence.
- IP54 is design intent only until dust and splash lab rows are populated.

## Release Rule

- Every modeled ingress path must have a CAD seal stack, mesh overhang where acoustic ports are open, and measured dust/splash results before environmental release.
