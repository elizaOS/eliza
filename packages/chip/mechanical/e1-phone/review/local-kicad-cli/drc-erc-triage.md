# E1 Phone Local KiCad DRC/ERC Triage

Status: `blocked_local_kicad_drc_erc_violations_present`

This report is derived from local KiCad JSON outputs and has no release credit.

## DRC Types

- `clearance`: 499
- `unconnected_items`: 446
- `solder_mask_bridge`: 200
- `copper_edge_clearance`: 199
- `items_not_allowed`: 199
- `shorting_items`: 192
- `tracks_crossing`: 134
- `courtyards_overlap`: 81
- `hole_clearance`: 67
- `silk_overlap`: 54
- `silk_over_copper`: 51
- `drill_out_of_range`: 24
- `starved_thermal`: 22
- `via_diameter`: 20
- `track_dangling`: 7
- `holes_co_located`: 4
- `silk_edge_clearance`: 1
- `via_dangling`: 1

## ERC Types

- `global_label_dangling`: 127
- `pin_not_connected`: 80
- `label_dangling`: 44
- `power_pin_not_driven`: 30
- `endpoint_off_grid`: 23
- `lib_symbol_issues`: 23
- `footprint_link_issues`: 15
- `pin_not_driven`: 14
- `pin_to_pin`: 6
- `no_connect_connected`: 4

## Next Actions

- Fix high-count DRC classes first: clearance, unconnected items, solder mask bridges, copper-edge clearance, forbidden items, shorts, and tracks crossing.
- Fix high-count ERC classes first: dangling labels, unconnected pins, not-driven power pins, off-grid endpoints, symbol issues, and footprint links.
- After cleanup, regenerate local KiCad reports and only promote production reports after reviewer-approved clean results or explicit signed waivers.
