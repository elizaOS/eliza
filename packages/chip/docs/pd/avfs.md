# AVFS controller contract

Status: `planning_evidence_release_blocked`

## Scope

Adaptive Voltage / Frequency Scaling closed-loop controller for the six
DVFS-managed rails:

| Rail               | Enum                  | Source rail in rail plan |
| ------------------ | --------------------- | ------------------------ |
| CPU big            | `DVFS_RAIL_CPU_BIG`   | `VDD_CPU_BIG`            |
| CPU little         | `DVFS_RAIL_CPU_LITTLE`| `VDD_CPU_LITTLE`         |
| NPU                | `DVFS_RAIL_NPU`       | `VDD_NPU`                |
| GPU                | `DVFS_RAIL_GPU`       | `VDD_GPU`                |
| SoC fabric / NoC   | `DVFS_RAIL_SOC_FABRIC`| `VDD_SOC_FABRIC`         |
| SRAM               | `DVFS_RAIL_SRAM`      | `VDD_SRAM`               |

Each AVFS instance produces a `target_code_o` value at `DVFS_STEP_UV`
(6.25 mV) granularity. The output is consumed by `rtl/power/dldo.sv` on-die
regulators (CPU/NPU rails) and by the PMC firmware off-chip PMIC sequencer
(all rails).

## Loop architecture

```
canary_margin_low_i[CANARY_COUNT-1:0]   ┐
canary_margin_high_i[CANARY_COUNT-1:0]  ┤   AVFS update tick
                                        ├──> target_code_o (+/- 1 LSB)
       min_code_i, max_code_i          ┘
```

- `CANARY_COUNT = AVFS_CANARY_COUNT = 16`: per-rail in-situ critical-path
  replicas spread across the floorplan.
- Update period = `AVFS_UPDATE_CYCLES` (= 20_000 at 200 MHz = 100 us).
- Any low margin -> raise target by 1 LSB on next update.
- All canaries high margin (and none low) -> lower target by 1 LSB.
- Clamp at [min_code_i, max_code_i] supplied by PMC firmware from the
  per-corner DVFS table.
- `fault_o` asserts if raise saturates at `max_code_i` (silicon is slower
  than the DVFS table allows; needs human-in-loop response).

## Per-corner DVFS tables

Generated at silicon characterization from `pd/signoff/sta/*` corner sweeps.
Three production tables binned by silicon corner (SS, TT, FF), each parameterized
by junction temperature (0 / 25 / 85 / 105 °C). The PMC firmware
loads the appropriate table at boot based on fuse settings and the on-die
DTSs.

See `docs/evidence/power/dvfs-table-evidence.yaml` for the production gate.
The skeleton format is in `docs/pd/dvfs-tables/`.

## Verification

- Cocotb: `verify/cocotb/power/test_avfs_convergence.py` — 5/5 tests pass.
- Tests cover: raise under low margin, lower under high margin, clamp at
  `max_code_i` with fault, clamp at `min_code_i`, disable holds init code.
- Make target: `make cocotb-avfs`.

## Release blockers

- Canary FF cell library not selected (foundry-dependent).
- Per-corner DVFS tables not generated.
- AVFS loop stability margin (gain, phase) not analyzed against full PDN
  impedance profile.
- Integration with PMIC SPMI sequencer not closed.

## References

- Intel Voltage Smart, ISSCC 2014
- ARM Adaptive Voltage Scaling, in-situ margin monitors
- "Computational Digital LDO for Mobile SoC" (2024, public)
