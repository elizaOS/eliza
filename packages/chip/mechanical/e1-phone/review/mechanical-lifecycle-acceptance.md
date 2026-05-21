# E1 Phone Mechanical Lifecycle Acceptance

Status: blocked_no_lifecycle_results.

This gate blocks production-ready claims for buttons, USB-C, and screen bonding until lifecycle rows and calibrated fixtures pass.

## Criteria

- BLOCKED: `power_button_pressure_travel_lifecycle` - power key force/travel stays in range with zero stuck, rattle, crack, or missed tactile events after 100k cycles
- BLOCKED: `volume_button_pressure_travel_lifecycle` - volume key force/travel stays in range at center and both ends with zero cycle failures after 100k cycles
- BLOCKED: `usb_c_insertion_cycle_capture` - USB-C plug inserts without aperture rub, remains <=40 N after 2k cycles, and has zero continuity failures
- BLOCKED: `screen_bond_fpc_lifecycle` - screen adhesive compression and FPC bend stay in range with zero screen lift, touch/display fault, or connector fault after handling cycles

## Missing Or Incomplete

- `power_button_pressure_travel_lifecycle`
- `volume_button_pressure_travel_lifecycle`
- `usb_c_insertion_cycle_capture`
- `screen_bond_fpc_lifecycle`

## Release Rule

- Every mechanical lifecycle criterion must have all fixture-backed EVT rows populated, numerically passing, and explicitly passed before claiming buttons, USB-C insertion, or screen mounting are production-ready.
