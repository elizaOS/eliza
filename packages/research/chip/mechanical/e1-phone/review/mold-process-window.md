# E1 Phone Mold Process Window

Status: CAD-derived process window ready; mold-flow, first shots, and toolmaker signoff still required.

## Quantified Proxies

- PASS: `fill_length_to_wall` actual 133.6 target <= 120 preferred, <= 160 caution for long thin PC+ABS shells risk medium
- PASS: `clamp_tonnage_window` actual {'projected_area_mm2': 11980.8, 'estimated_tons_low': 41.9, 'estimated_tons_high': 65.9} target Quote tool and press capacity above the high estimate with supplier resin pressure data. risk medium
- PASS: `gate_shear_proxy` actual {'gate_to_wall_ratio': 0.739, 'total_gate_area_mm2': 3.74} target 0.50-0.80 wall ratio with toolmaker-confirmed gate land and vestige risk medium
- PASS: `cooling_clearance_ratio` actual {'channel_clearance_to_diameter': 2.0, 'modeled_channels': 3} target >= 2.0 diameters, with final baffles/conformal cooling from toolmaker risk medium
- PASS: `boss_sink_proxy` actual {'boss_wall_to_nominal_wall': 1.043, 'rib_to_wall_ratio': 0.652} target boss wall <= 1.10x nominal and ribs <= 0.70x nominal risk medium
- PASS: `ejector_cosmetic_proxy` actual {'modeled_ejector_pins': 8} target 8 pins with marks hidden from exterior A-surfaces risk medium

## Process Window

- Melt temperature: 245-275 C
- Mold temperature: 70-95 C
- Drying: Dry PC+ABS per resin datasheet before molding; record dryer dew point and residence time.
- Pack/hold: Start with 95-99% fill transfer, stepped pack/hold DOE, and gate-freeze study.
- Venting: Add vents at end-of-fill around top corners, camera window, USB saddle, and snap-hook roots.

## Toolmaker Questions

- Run mold-flow fill/pack/warp with selected orange PC+ABS resin, dual submarine gates, and fan-gate alternate.
- Return predicted pressure at V/P transfer, clamp tonnage, weld lines, air traps, shrink, and corner warp.
- Confirm gate size, land length, vent locations, ejector layout, cooling layout, and steel-safe tuning stock.
- Review whether the long thin shell needs additional gating or flow leaders before DVT tooling.

## First-Shot DOE

- `melt_temperature_c` levels [245, 260, 275]
- `mold_temperature_c` levels [70, 82, 95]
- `pack_pressure_percent` levels [60, 75, 90]
- `hold_time_s` levels [2.0, 4.0, 6.0]
- `cooling_time_s` levels [12.0, 18.0, 24.0]
