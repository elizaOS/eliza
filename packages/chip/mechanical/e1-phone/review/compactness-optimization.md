# E1 Phone Compactness Optimization

Status: cad_compactness_optimized.

## Decision

Keep 78.0 x 153.6 x 9.6 mm molded orange body: width is within 0.3 mm of the display-driven lower bound, height preserves only 1.23 mm over the display lower bound for rails, adhesive tolerance, corner radius, and assembly handling.

## Cases

- PASS: `display_driven_width` target <=1.0 mm width excess over selected CTP plus screen allowance
- PASS: `display_driven_height` target <=1.5 mm height excess over selected CTP plus screen allowance
- PASS: `sub_10mm_molded_depth` target molded slab depth <=10 mm with no solid package protruding outside the enclosure datum
- PASS: `side_controls_do_not_resize_molded_body` target side buttons may protrude locally but keep molded orange body at the display-driven width
- PASS: `pcb_battery_do_not_drive_outer_envelope` target selected display, not PCB or battery, remains the outer-envelope driver

## Next Reduction Options

- A shorter display/CTP supplier module is the only meaningful path to reduce outer height.
- A flush or smaller rear camera window would reduce external Z protrusion, but the selected AF module still needs supplier lens-stack confirmation.
- Side button cap protrusion can be reduced by supplier switch/cap tooling, but the molded orange body is already display-limited.
- Routed KiCad board and supplier STEP may permit local internal improvements, not a major envelope reduction with the current display.
