# E1 Full OpenLane Release Baseline - 2026-05-19

Command:

```sh
OPENLANE_TIMEOUT_SECONDS=3600 scripts/run_openlane.sh --release
```

Run tag observed in the OpenLane container:

```text
RUN_2026-05-19_03-36-13
```

## Status

The wrapper timed out after one hour, but the OpenLane Docker process continued and reached late signoff. KLayout DRC and Magic DRC both passed before the container exited. The run proceeded through Magic SPICE extraction and Netgen LVS after that point, but no final packaged run directory was visible from the host after the `--rm` container exited, so this note records the metrics captured from the live container rather than a durable final `metrics.json`.

## Captured Metrics

Captured from `70-checker-illegaloverlap/state_out.json` while the container was still live:

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

1. Re-run release without a one-hour timeout, or raise `OPENLANE_TIMEOUT_SECONDS`, and preserve the final run directory.
2. Add a hard-macro or soft-macro E1 floorplan target before using AlphaChip for serious E1 placement comparison.
3. Compare AlphaChip placement against OpenROAD/OpenLane macro placement using the same validation loop: routed wire length, congestion, timing, DRC, LVS, antenna, and IR drop.
