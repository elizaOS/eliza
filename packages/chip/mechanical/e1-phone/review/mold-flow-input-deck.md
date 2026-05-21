# E1 Phone Mold-Flow Input Deck

Status: mold_flow_input_deck_ready.

This deck defines the required mold-flow result package; it is not returned simulation evidence.

## Required Outputs

- `fill_pressure_at_vp_transfer_mpa`: <= 85% of selected press/resin limit
- `clamp_tonnage_margin`: selected press capacity >= CAD high clamp-tonnage estimate
- `max_warp_after_shrink_mm`: <= 0.35 mm across cover-glass bonding ledge and <= 0.50 mm across back shell
- `sink_at_boss_and_rib_readthrough_mm`: <= 0.05 mm on exterior A-surfaces over bosses/ribs
- `weld_lines_on_cosmetic_surfaces`: no weld lines on front orange rail, back hero surface, camera window land, or USB-C lip
- `air_traps_at_ports_and_snap_hooks`: vents added or air traps cleared at USB-C saddle, camera window, acoustic ports, and snap-hook roots
- `cooling_delta_t_and_cycle_time`: <= 8 C cavity surface delta and quoted cycle time <= 30 s
- `orange_gate_blush_and_vestige`: gate vestige outside A-surface and blush accepted on orange plaque/first shots
