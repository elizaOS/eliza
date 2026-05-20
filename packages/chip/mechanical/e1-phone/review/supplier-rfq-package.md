# E1 Phone Supplier RFQ Package

Status: generated RFQ package from EVT0 CAD evidence; not supplier lock.

## display_touch_stack

- Candidate: Chenghao CH550FH01A-CT class 5.5 inch MIPI LCD + CTP
- Attached STEP evidence: mechanical/e1-phone/out/screen_cover_glass.step, mechanical/e1-phone/out/display_lcm.step, mechanical/e1-phone/out/display_fpc_connector.step, mechanical/e1-phone/out/screen_adhesive_top.step
- Questions:
  - Confirm CTP/LCM outline, cover-glass thickness, active area, and stack tolerance.
  - Confirm FPC exit side, bend radius, connector family, and mating connector drawing.
  - Quote bonded cover glass plus touch/display module as low-volume OEM assembly if available.

## usb_c_and_bottom_audio

- Candidate: GCT USB4105 USB2 Type-C receptacle, reinforced shell
- Attached STEP evidence: mechanical/e1-phone/out/usb_c_receptacle.step, mechanical/e1-phone/out/usb_c_external_aperture.step, mechanical/e1-phone/out/usb_c_perimeter_gasket_top.step, mechanical/e1-phone/out/usb_c_perimeter_gasket_bottom.step, mechanical/e1-phone/out/usb_c_perimeter_gasket_left.step, mechanical/e1-phone/out/usb_c_perimeter_gasket_right.step, mechanical/e1-phone/out/usb_c_molded_drip_break_lip.step, mechanical/e1-phone/out/usb_c_internal_drain_shelf.step, mechanical/e1-phone/out/bottom_speaker_module.step, mechanical/e1-phone/out/bottom_speaker_acoustic_chamber.step, mechanical/e1-phone/out/bottom_mic.step, mechanical/e1-phone/out/bottom_microphone_port_1.step
- Questions:
  - Confirm exact USB-C suffix, footprint, shell stake geometry, and 20k-cycle rating.
  - Confirm whether supplier can provide a gasketed receptacle seat or validate the modeled perimeter gasket/drip shelf.
  - Confirm speaker module acoustic rear-volume needs and gasket compression range.
  - Confirm MEMS microphone port, dust mesh, gasket stack, and keepout around USB shell.

## camera_stack

- Candidate: rear OV13855-class AF plus front 5-8 MP FF module
- Attached STEP evidence: mechanical/e1-phone/out/rear_camera_module.step, mechanical/e1-phone/out/rear_camera_cover_glass.step, mechanical/e1-phone/out/rear_camera_lens_window.step, mechanical/e1-phone/out/front_camera_module.step, mechanical/e1-phone/out/front_camera_under_glass.step
- Questions:
  - Confirm rear module total height, FPC exit side, lens keepout, and dust gasket stack.
  - Confirm front module can sit behind cover glass without visible notch or protrusion.
  - Quote matched rear/front MIPI modules with low-volume sample availability.

## buttons_haptics_service

- Candidate: Panasonic EVQ-P7/P3/9P7 side-push tactile switch
- Attached STEP evidence: mechanical/e1-phone/out/power_button_cap.step, mechanical/e1-phone/out/volume_button_cap.step, mechanical/e1-phone/out/power_button_elastomer_gasket.step, mechanical/e1-phone/out/power_button_labyrinth_upper_rail.step, mechanical/e1-phone/out/power_button_labyrinth_lower_rail.step, mechanical/e1-phone/out/volume_button_elastomer_gasket.step, mechanical/e1-phone/out/volume_button_labyrinth_upper_rail.step, mechanical/e1-phone/out/volume_button_labyrinth_lower_rail.step, mechanical/e1-phone/out/haptic_lra.step, mechanical/e1-phone/out/sim_tray_keepout.step, mechanical/e1-phone/out/sim_tray_outline.step
- Questions:
  - Confirm side tactile switch part number, force bins, travel, and actuator tolerance stack.
  - Confirm side-key silicone gasket material, compression set, and splash/dust test acceptance.
  - Confirm LRA vendor drawing, adhesive/fixture requirements, and drive limits.
  - Confirm whether nano-SIM tray is required or eSIM-only is acceptable for EVT.

## orange_enclosure_tooling

- Candidate: PC+ABS or glass-filled PC/ABS, molded orange
- Attached STEP evidence: mechanical/e1-phone/out/orange_back_shell.step, mechanical/e1-phone/out/orange_side_frame.step, mechanical/e1-phone/out/orange_screw_boss_1.step, mechanical/e1-phone/out/orange_snap_hook_1.step, mechanical/e1-phone/out/orange_usb_reinforcement_saddle.step, mechanical/e1-phone/out/e1-phone-mold-tooling.glb
- Questions:
  - Quote CNC prototype, soft-tool injection, and hard-tool injection options in safety orange PC+ABS.
  - Review draft, rib/boss ratios, snap hooks, gate vestige, ejector marks, texture, and color matching.
  - Return mold-flow/fill balance recommendation for the long thin back cover and side frame.
