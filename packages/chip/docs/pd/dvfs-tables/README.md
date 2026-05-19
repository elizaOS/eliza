# Per-corner DVFS tables

Status: `placeholder_format_release_blocked`

## Scope

The PMC firmware (`fw/pmc/src/dvfs_arbiter.c`) loads one DVFS table per
silicon corner at boot. Three production tables are required:

- `dvfs-table-ss.yaml`
- `dvfs-table-tt.yaml`
- `dvfs-table-ff.yaml`

Each table is generated at silicon characterization from the
corner sweep at `pd/signoff/sta/<corner>/`. Today only the format skeleton
exists; the values are **placeholders** and not release-grade.

## Schema

```yaml
schema: eliza.dvfs_table.v1
corner: tt | ss | ff
process_temperature_c: 25
rails:
  VDD_CPU_BIG:
    operating_points:
      - frequency_hz: 800000000
        nominal_code: 0x40       # 0.40 V = 0x40 * 6.25 mV
        min_code: 0x38
        max_code: 0x48
      - frequency_hz: 1600000000
        nominal_code: 0x60
        min_code: 0x58
        max_code: 0x68
      - frequency_hz: 3200000000
        nominal_code: 0xA0
        min_code: 0x98
        max_code: 0xB0
  VDD_NPU:
    operating_points:
      ...
```

`nominal_code` is the production V/F point at the corner. `min_code` /
`max_code` define the AVFS slew window: in-situ AVFS may adjust within
[min, max] based on canary feedback. Crossing `max_code` raises
`fault_o` on the AVFS controller.

## Generation pipeline (planned)

1. Run STA at SS/TT/FF + 0/25/85/105 °C corners for each AVFS-managed rail.
2. Compute the worst-case slowest path per rail and bin the voltage that
   meets the frequency target.
3. Add 6.25 mV guardband on top.
4. Emit one YAML per corner; checksum each.
5. Flash the three tables into PMC SRAM as compile-time constants in
   `fw/pmc/src/dvfs_arbiter.c`.

## Release blockers

- Silicon characterization data not available.
- STA corner sweep not run for the target 14A PDK (PDK selection pending).
- Voltage guardband policy not formally adopted; placeholder of one DVFS LSB
  (6.25 mV) is documented but not signed off.

## Verification

`scripts/check_dvfs_tables.py` (TBD) enforces:

- All three corner files present and schema-valid.
- All six DVFS-managed rails covered in each file.
- `min_code <= nominal_code <= max_code` for every operating point.
- `min_code` and `max_code` within the [`dvfs_min_v`, `dvfs_max_v`] window
  declared in `docs/pd/rail-plan-2028.yaml`.

Today the production gate
(`docs/evidence/power/dvfs-table-evidence.yaml`) fails closed.
