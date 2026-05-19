# Eliza E1 v0 thermal stack

Date: 2026-05-19
Status: planning. No board exists. No silicon power is measured.
Claim boundary: Planning document. Promotion requires fabricated boards with
TIM applied, IR thermal-camera captures at sustained workloads, and
correlated thermistor readings under the IEC 60950-1 / IEC 62368-1 skin
temperature limit (≤ 43-45 °C).

## v0 thermal envelope assumptions

| Block        | Burst (W) | Sustained (W) | Source                                                     |
| ------------ | --------: | ------------: | ---------------------------------------------------------- |
| AP cluster   |       2.5 |           1.4 | `docs/architecture-optimization/soc-optimized-operating-point.yaml#cpu_active_w_max` |
| NPU          |       3.0 |           1.2 | same `npu_active_w_max`                                    |
| LPDDR PHY+DDR|       0.8 |           0.5 | LPDDR5X 6.4 Gb/s burst budget                              |
| Display+DSI  |       0.4 |           0.4 | 720x1280 backlight + DSI driver                            |
| Wi-Fi/BT     |       1.2 |           0.3 | Murata Type 1DX TX peak                                    |
| Misc PMIC/   |       0.5 |           0.2 | regulator + audio + sensors quiescent                      |
|  audio       |           |               |                                                            |
| **Total**    |     **8.4** |       **4.0** |                                                            |

Peak budget aligns with `research/process_packaging_2026/02_analysis/thermal_reliability_2nm.md`:
vapor-chamber transient phase absorbs 4-8 W; post-saturation steady-state
holds 4-6 W. v0 must clear the steady-state envelope with **no vapor chamber**.

## v0 thermal stack (no vapor chamber)

Stack from die outward:

```
SoC die (face-down BGA)
  └─► Package lid (no IHS in v0; bare die)
        └─► TIM 1: Honeywell PTM7950 (phase-change TIM, 1.5 mm² @ 8 W/mK)
              └─► Graphite spreader: 100 mm x 60 mm x 75 µm artificial graphite
                    └─► Gap filler 2 mm thick (e.g. Bergquist Gap Pad TGP 5000)
                          └─► Back cover (3 mm aluminium + plastic shell)
                                └─► Ambient
```

## v1 upgrade path (vapor chamber)

If v0 measured silicon power exceeds 4 W sustained at 43 °C skin, upgrade
to a v1 thermal stack:

```
SoC die
  └─► TIM 1: PTM7950
        └─► Vapor chamber: 80 mm x 50 mm x 0.5 mm (e.g. CCI vapor chamber)
              └─► Graphite spreader 100 mm x 60 mm x 75 µm
                    └─► Gap filler 1 mm
                          └─► Back cover
                                └─► Ambient
```

Vapor chamber adds ~ 1.5 °C/W of thermal resistance reduction at the die
junction at the cost of 0.5 mm thickness and a per-unit BOM increase
in the $2-5 range.

## Skin temperature plan

- Two NTC thermistors on the mainboard near hot blocks (AP and NPU) for
  closed-loop AOSP Thermal HAL throttling.
- One NTC on the inside of the back cover for skin-temp limit enforcement.
- AOSP Thermal HAL v2.0 cooling devices defined per
  `package/pmic/da9063.yaml` rail mapping; cpufreq + npufreq throttle to
  meet ≤ 43 °C skin in worst case.

## Validation gates (all currently fail-closed)

- IR thermal camera capture at 30-min sustained CPU+NPU 100% workload.
- Two-point thermistor logging at 1 Hz during the same workload.
- Skin-temperature compliance per IEC 60950-1 / IEC 62368-1.
- AOSP Thermal HAL throttling transcript showing the throttle policy fires
  before skin temp violations.

## Cross-references

- `docs/architecture-optimization/physical-power-thermal.md`
- `docs/architecture-optimization/soc-optimized-operating-point.yaml`
- `docs/spec-db/process-14a-effects.yaml`
- `research/process_packaging_2026/02_analysis/thermal_reliability_2nm.md`
- `research/mobile_platform_2026/02_analysis/sensors_audio_thermal.md`
