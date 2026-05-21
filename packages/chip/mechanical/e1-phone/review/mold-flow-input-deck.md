# E1 Phone Mold-Flow Input Deck

Status: mold_flow_input_deck_ready.

This is the CAD-side setup contract for returned mold-flow analysis; it is not simulation evidence.

## Geometry Sources

- `assembly_step`: `mechanical/e1-phone/out/e1-phone-solid-assembly.step`
- `mold_tooling_glb`: `mechanical/e1-phone/out/e1-phone-mold-tooling.glb`
- `tooling_render`: `mechanical/e1-phone/review/mold_tooling.png`
- `tooling_manifest`: `mechanical/e1-phone/out/tooling-manifest.json`

## Required Outputs

- `fill_pressure_at_vp_transfer_mpa`
- `clamp_tonnage_margin`
- `max_warp_after_shrink_mm`
- `sink_at_boss_and_rib_readthrough_mm`
- `weld_lines_on_cosmetic_surfaces`
- `air_traps_at_ports_and_snap_hooks`
- `cooling_delta_t_and_cycle_time`
- `orange_gate_blush_and_vestige`

## Critical Regions

- USB-C saddle and drip lip
- front glass bonding ledge
- rear camera cover land
- snap-hook roots
- screw bosses and battery ribs
- speaker and microphone aperture fields
