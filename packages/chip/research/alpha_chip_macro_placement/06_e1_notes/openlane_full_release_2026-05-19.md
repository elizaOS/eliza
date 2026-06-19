# E1 Full OpenLane Release Baseline - 2026-05-19

Command:

```sh
OPENLANE_TIMEOUT_SECONDS=3600 scripts/run_openlane.sh --release
```

Run tag observed in the OpenLane container:

```text
RUN_2026-05-19_05-08-54
```

## Status

The release run completed and produced final OpenLane artifacts:

- `pd/openlane/runs/RUN_2026-05-19_05-08-54/final/gds/e1_chip_top.gds`
- `pd/openlane/runs/RUN_2026-05-19_05-08-54/final/def/e1_chip_top.def`
- `pd/openlane/runs/RUN_2026-05-19_05-08-54/final/metrics.json`

## Captured Metrics

Captured from `final/metrics.json`:

| Metric | Value |
| --- | ---: |
| Die area | 3,240,000 |
| Core area | 2,616,850 |
| Instances | 142,274 |
| Standard cells | 142,274 |
| Macros | 0 |
| Macro area | 0 |
| Standard-cell area | 693,745 |
| Utilization | 0.265107 |
| Antenna cells | 56,837 |
| Routed wire length | 3,643,344 |
| Vias | 512,910 |
| TritonRoute DRC errors | 0 |
| Magic DRC errors | 0 |
| KLayout DRC errors | 0 |
| LVS errors | 0 |
| Setup worst slack | 70.6511988910204 |
| Setup TNS | 0 |
| Hold worst slack | -0.109080303432843 |
| Hold TNS | -0.14365598006661115 |
| Max slew violations | 23,099 |
| Max capacitance violations | 442 |

## AlphaChip Implication

This E1 release netlist has no hard macros. AlphaChip-style macro placement is therefore not the limiting optimization surface yet. To make AlphaChip useful for E1, the next physical-design step is to introduce placeable blocks: real hard SRAM/cache/NPU/peripheral macros, or an explicit clustering pass that converts selected logic regions into soft macros.

The current placement bottleneck is standard-cell timing/routing/signoff quality rather than macro floorplanning. In particular, the captured full run had clean routing and DRC, but still had hold, slew, and capacitance violations after post-route signoff metrics were captured.

## Follow-Up

1. Use the generated 256-soft-macro AlphaChip benchmark as the current macro-placement proxy.
2. Add real hard macros or a more intentional clustering pass before treating AlphaChip results as tapeout-relevant floorplanning.
3. Compare AlphaChip placement against OpenROAD/OpenLane macro placement using the same validation loop: routed wire length, congestion, timing, DRC, LVS, antenna, and IR drop.
