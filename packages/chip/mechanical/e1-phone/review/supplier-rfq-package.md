# E1 Phone Supplier RFQ Package

Status: generated RFQ package from EVT0 CAD evidence; not supplier lock.

## display_touch_stack

- Candidate: Chenghao CH550FH01A-CT class 5.5 inch MIPI LCD + CTP
- Attached STEP evidence:
- Questions:
  - Confirm CTP/LCM outline, cover-glass thickness, active area, and stack tolerance.
  - Confirm FPC exit side, bend radius, connector family, and mating connector drawing.
  - Quote bonded cover glass plus touch/display module as low-volume OEM assembly if available.

## usb_c_and_bottom_audio

- Candidate: GCT USB4105 USB2 Type-C receptacle, reinforced shell
- Attached STEP evidence:
- Questions:
  - Confirm exact USB-C suffix, footprint, shell stake geometry, and 20k-cycle rating.
  - Confirm whether supplier can provide a gasketed receptacle seat or validate the modeled perimeter gasket/drip shelf.
  - Confirm speaker module acoustic rear-volume needs and gasket compression range.
  - Confirm MEMS microphone port, dust mesh, gasket stack, and keepout around USB shell.

## camera_stack

- Candidate: rear OV13855-class AF plus front 5-8 MP FF module
- Attached STEP evidence:
- Questions:
  - Confirm rear module total height, FPC exit side, lens keepout, and dust gasket stack.
  - Confirm rear cover-window adhesive gasket material, baffle clearance, and dust-control process.
  - Confirm front module can sit behind cover glass and black mask without visible notch or protrusion.
  - Quote matched rear/front MIPI modules with low-volume sample availability.

## buttons_haptics_service

- Candidate: XKB TS-1187A-B-A-B side-push tactile switch, 3.5x2.9x1.7 mm
- Attached STEP evidence:
- Questions:
  - Confirm side tactile switch part number, force bins, travel, and actuator tolerance stack.
  - Confirm side-key silicone gasket material, compression set, and splash/dust test acceptance.
  - Confirm LRA vendor drawing, adhesive/fixture requirements, and drive limits.
  - Confirm whether nano-SIM tray is required or eSIM-only is acceptable for EVT.

## orange_enclosure_tooling

- Candidate: PC+ABS or glass-filled PC/ABS, molded orange
- Attached STEP evidence: mechanical/e1-phone/out/e1-phone-mold-tooling.glb
- Questions:
  - Quote CNC prototype, soft-tool injection, and hard-tool injection options in safety orange PC+ABS.
  - Review draft, rib/boss ratios, snap hooks, gate vestige, ejector marks, texture, and color matching.
  - Return mold-flow/fill balance recommendation for the long thin back cover and side frame.

