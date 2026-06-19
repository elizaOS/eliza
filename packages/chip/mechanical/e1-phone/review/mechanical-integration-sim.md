# E1 Phone Mechanical Integration Simulation

Status: cad_mechanical_integration_sim_ready.

This is deterministic CAD planning evidence only; physical release gates stay closed.

## Cases

- PASS: `usb_c_insertion_load_planning` target >=0.15 mm shell-to-aperture clearance, plug clearance positive, predicted peak insertion force <=35 N, cycle rating >=10000
- PASS: `screen_bond_clamp_and_fpc_planning` target four-sided adhesive, 0.03-0.08 mm compression, FPC bend radius >=1.0 mm, display CAD cases pass
- PASS: `side_button_force_pressure_planning` target power and volume force 1.2-2.2 N, travel >=0.18 mm, cap pressure <= limit

## Release Rule

- Release still requires physical USB insertion/cycle data, bonded display peel and compression data, FPC bend inspection, and button force/travel/cycle measurements with calibrated fixtures and lot traceability.
