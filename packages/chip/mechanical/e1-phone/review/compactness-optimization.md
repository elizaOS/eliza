# E1 Phone Compactness Optimization

Status: cad_compactness_optimized.

## Decision

Keep 78.0 x 153.6 x 11.2 mm molded orange body: width/height stay display-driven; depth was deliberately raised to fully bury the rear camera and torch under a flat flush back wall (no camera bump, no proud lens ring).

## Cases

- PASS: `display_driven_width` target <=1.0 mm width excess over selected CTP plus screen allowance
- PASS: `display_driven_height` target <=1.5 mm height excess over selected CTP plus screen allowance
- PASS: `flush_back_molded_depth` target molded slab depth <=11.5 mm with a fully flush flat back: zero rear solid protrusion and no package outside the enclosure datum
- PASS: `side_controls_do_not_resize_molded_body` target side buttons may protrude locally but keep molded orange body at the display-driven width
- PASS: `pcb_battery_do_not_drive_outer_envelope` target selected display, not PCB or battery, remains the outer-envelope driver

## Next Reduction Options

- A shorter display/CTP supplier module is the only meaningful path to reduce outer height.
- Outer depth is set by the flush-back decision to bury the rear AF module; a thinner rear module or thinner battery would be the only path to reduce depth.
- Side button cap protrusion can be reduced by supplier switch/cap tooling, but the molded orange body is already display-limited.
- Routed KiCad board and supplier STEP may permit local internal improvements, not a major envelope reduction with the current display.
