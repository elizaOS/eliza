# E1 Phone Mold-Flow Acceptance

Status: mold_flow_results_pass.

This gate separates CAD process-window planning from returned mold-flow and toolmaker evidence.

## Criteria

- `fill_pressure_at_vp_transfer_mpa`: <= 85% of selected press/resin limit
  Required evidence: fill_pressure_plot, selected_press_spec, resin_pressure_limit_table
  Numeric outputs: vp_transfer_pressure_mpa, press_pressure_limit_mpa, percent_of_limit
- `clamp_tonnage_margin`: selected press capacity >= 79.1 tons
  Required evidence: clamp_tonnage_report, press_quote_or_machine_spec, projected_area_basis
  Numeric outputs: projected_area_cm2, estimated_peak_tons, selected_press_capacity_tons
- `max_warp_after_shrink_mm`: <= 0.35 mm across cover-glass bonding ledge and <= 0.50 mm across back shell
  Required evidence: post_shrink_warp_plot, gdt_datum_overlay, shrink_compensation_table
  Numeric outputs: glass_ledge_warp_mm, back_shell_warp_mm, datum_shift_mm
- `sink_at_boss_and_rib_readthrough_mm`: <= 0.05 mm on exterior A-surfaces over bosses/ribs
  Required evidence: sink_readthrough_plot, boss_rib_location_overlay, a_surface_cosmetic_map
  Numeric outputs: max_boss_sink_mm, max_rib_readthrough_mm, a_surface_sink_mm
- `weld_lines_on_cosmetic_surfaces`: no weld lines on front orange rail, back hero surface, camera window land, or USB-C lip
  Required evidence: weld_line_plot, cosmetic_keepout_overlay, gate_location_revision
  Numeric outputs: cosmetic_weld_line_count, nearest_weld_to_camera_land_mm, nearest_weld_to_usb_lip_mm
- `air_traps_at_ports_and_snap_hooks`: vents added or air traps cleared at USB-C saddle, camera window, acoustic ports, and snap-hook roots
  Required evidence: air_trap_plot, vent_layout_markup, critical_port_region_overlay
  Numeric outputs: unvented_usb_air_traps, unvented_acoustic_air_traps, unvented_snap_hook_air_traps
- `cooling_delta_t_and_cycle_time`: <= 8 C cavity surface delta and quoted cycle time <= 30 s
  Required evidence: cooling_delta_t_plot, cooling_circuit_layout, cycle_time_prediction
  Numeric outputs: max_cavity_delta_t_c, predicted_cycle_time_s, hotspot_count
- `orange_gate_blush_and_vestige`: gate vestige outside A-surface and blush accepted on orange plaque/first shots
  Required evidence: gate_vestige_markup, orange_color_plaque_photo, gate_blush_limit_sample
  Numeric outputs: a_surface_gate_vestige_count, vestige_height_mm, delta_e_orange_plaque

## Missing Or Incomplete


## Release Rule

- Every mold-flow criterion must include a named toolmaker, returned artifact, measured/predicted value, reviewer, and accepted disposition before tooling release.
