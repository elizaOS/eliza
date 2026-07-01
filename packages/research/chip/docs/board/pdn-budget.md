# Eliza E1 v0 PDN target impedance budget

Date: 2026-05-19
Status: planning. No board exists. No rail is measured.
Claim boundary: This document captures the v0 PDN target-impedance budget.
Promotion requires post-layout SPICE / S-parameter extraction, transient
co-simulation against real switching activity, and measured TDR captures on
fabricated boards.

## Method

For each rail the target PDN impedance is computed from the supply voltage,
the worst-case transient current, and the allowed transient ripple:

```
Z_target_max = (V_rail * ripple_pct / 100) / I_transient_worst
```

Decoupling capacitance is then chosen so the PDN impedance stays below
`Z_target_max` from DC up to the activity bandwidth (~ 1 / (10 × rise time)).
All numbers below are planning targets, not signoff impedance numbers.

## Per-rail targets

| Rail                 | V (V) | I_transient (A) | ripple_pct | Z_target_max (mΩ) | Bandwidth (MHz)         |
| -------------------- | ----: | --------------: | ---------: | ----------------: | ----------------------- |
| BUCKCORE (cpu-supply)|  1.00 |             2.5 |        3.0 |              12.0 | DC..300                 |
| BUCKPRO (npu-supply) |  1.10 |             2.5 |        3.0 |              13.2 | DC..300                 |
| BUCKMEM (lpddr-vdd2) |  1.10 |             2.5 |        2.0 |               8.8 | DC..200                 |
| BUCKPERI (vdd-1v8)   |  1.80 |             1.0 |        5.0 |              90.0 | DC..100                 |
| LDO2 (vdd-pll-1v0)   |  1.00 |             0.1 |        1.0 |             100.0 | DC..50 (PLL critical)   |
| LDO3 (lpddr-vddq)    |  0.55 |             0.2 |        3.0 |              82.5 | DC..200                 |
| LDO5 (sensor-3v0)    |  3.00 |             0.05 |       5.0 |            3000.0 | DC..1                   |
| LDO6 (wifi-3v3)      |  3.30 |             1.0 |        5.0 |             165.0 | DC..100                 |
| LDO7 (audio-3v3)     |  3.30 |             0.2 |        2.0 |             330.0 | DC..50                  |
| LDO8 (display-3v0)   |  3.00 |             0.2 |        5.0 |             750.0 | DC..50                  |
| LDO9 (emmc-3v3)      |  3.30 |             0.5 |        5.0 |             330.0 | DC..200                 |
| LDO10 (usb-phy-3v3)  |  3.30 |             0.2 |        2.0 |             330.0 | DC..200                 |

CPU + NPU rails are the dominant PDN risk. Aggregate transient on
BUCKCORE + BUCKPRO can pull ~5 A in 1 ns when both clusters wake from idle;
package + die decoupling must absorb the impulse.

## Decoupling strategy

- **On-die**: planned MIM-cap density per `docs/architecture-optimization/soc-optimized-operating-point.yaml`.
  Local 0V8/1V0 supplies need on-die MIM at the cluster vicinity.
- **Package**: substrate-cap density ≥ 1 µF per power island; embedded
  thin-film caps if available in 14A-class packaging.
- **PCB**: per the power-tree table — 22 µF MLCC near PMIC outputs plus
  per-island 4× 1 µF as close as possible to BGA balls.

## Validation gates (all currently fail-closed)

- Post-layout PDN extraction in OpenROAD / PSM (per the PD-flow recommendation
  in `research/pd_eda_2026/03_implementation/pd_path_for_e1.md`).
- Transient SPICE / IBIS-AMI co-simulation across CPU + NPU + memory PHY
  switching scenarios.
- Measured TDR / VNA captures on fabricated boards.

## Cross-references

- `docs/board/power-tree.md`
- `docs/architecture-optimization/soc-optimized-operating-point.yaml`
- `docs/architecture-optimization/physical-power-thermal.md`
- `research/mobile_platform_2026/02_analysis/pcb_si_pi.md`
- `research/pd_eda_2026/02_analysis/pdn_thermal_signoff.md`
