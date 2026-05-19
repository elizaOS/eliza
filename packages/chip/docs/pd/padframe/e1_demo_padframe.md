# E1 demo padframe plan

The first physical implementation target is a padless digital core. The standalone chip wrapper is specified by `package/e1-demo-pinout.yaml`.

The machine-readable padframe contract is `pd/padframe/e1_demo_padframe.yaml`. Run `make padframe-check` before changing the package pinout, top-level ports, or OpenLane pin-order file.

Required before fabrication:

- Select open shuttle or foundry pad library.
- Instantiate IO, power, ground, and corner pads.
- Add tie-high/tie-low cells for fixed test straps.
- Add ESD-compliant power clamp strategy.
- Add bonding diagram and package mapping.
- Re-run LVS/DRC against the padframe-inclusive top.

The contract check requires contiguous package pins, legal pad classes, sufficient power/ground pad counts, matching top-level RTL ports, and `pd/pin_order.cfg` coverage for every `e1_chip_top` port.
