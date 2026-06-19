# Eliza E1 v0 power tree

Date: 2026-05-19
Status: planning. No board exists. No rail is measured.
Claim boundary: This document captures the v0 board-level power tree intent.
Promotion requires bonded SoC pins, a PMIC binding (`package/pmic/da9063.yaml`),
a charger binding (`package/charger/max77860.yaml`), a USB-PD binding
(`package/usb-pd/tps65987.yaml`), a fabricated board, and per-rail
oscilloscope captures at boot, idle, and worst-case workload.

## Source path

```
USB-C PD source (5..20 V at PPS step 20 mV)
   └─► TPS65987DDH (USB-PD policy engine, sink-first)
         └─► VBUS_RAW (5..20 V, current-limited)
               └─► MAX77860 (charger)
                     ├─► VBAT  (1S Li-ion / Li-polymer 3.0..4.2 V)
                     │     └─► fuel-gauge MAX17260 (separate IC, not in v0 BOM yet)
                     └─► VSYS  (clamped ≥ 3.4 V; PMIC input)
                           └─► DA9063L (main PMIC)
                                 ├─► BUCKCORE  (0.85..1.40 V, ≤2.5 A)  →  AP core (RV64 cluster)
                                 ├─► BUCKPRO   (1.10..1.30 V, ≤2.5 A)  →  NPU core / GPU core
                                 ├─► BUCKMEM   (1.10..1.40 V, ≤2.5 A)  →  LPDDR5X VDD2 (planning) / LPDDR4X VDD2 (v0)
                                 ├─► BUCKPERI  (1.80 V, ≤1.5 A)        →  peripheral 1V8, sensor I2C, audio I2C
                                 ├─► LDO1      (0.6..1.8 V, 100 mA)    →  RTC backup domain
                                 ├─► LDO2      (0.6..1.8 V, 300 mA)    →  AP PLL + SRAM 1V0
                                 ├─► LDO3      (0.9..3.45 V, 300 mA)   →  LPDDR VDDQ
                                 ├─► LDO4      (0.9..3.45 V, 300 mA)   →  DSI AVDD 1V8
                                 ├─► LDO5      (0.9..3.6 V, 300 mA)    →  Sensors 3V0
                                 ├─► LDO6      (0.9..3.6 V, 200 mA)    →  WiFi/BT 3V3
                                 ├─► LDO7      (0.9..3.6 V, 200 mA)    →  Audio codec 3V3
                                 ├─► LDO8      (0.9..3.6 V, 200 mA)    →  Display panel 3V0
                                 ├─► LDO9      (0.9..3.6 V, 200 mA)    →  eMMC 3V3
                                 ├─► LDO10     (1.2..3.6 V, 300 mA)    →  USB PHY 3V3
                                 └─► LDO11     (1.2..3.6 V, 300 mA)    →  GPS / aux 3V3
```

## Rail-by-rail table

| Rail              | Owner    | Voltage (V)   | Peak A | Decoupling budget (µF)         | Linux power-domain name        |
| ----------------- | -------- | ------------- | -----: | ------------------------------ | ------------------------------ |
| VBUS_RAW          | USB-PD   | 5..20         |    3.0 | 22 µF bulk + 4× 10 µF MLCC     | n/a (charger input only)       |
| VBAT              | charger  | 3.0..4.2      |    3.0 | 100 µF bulk near charger       | `battery`                      |
| VSYS              | charger  | ≥ 3.4         |    3.0 | 22 µF bulk + 4× 10 µF MLCC     | `vsys`                         |
| BUCKCORE          | PMIC     | 0.85..1.40    |    2.5 | 2× 22 µF MLCC + 4× 1 µF        | `cpu-supply`                   |
| BUCKPRO           | PMIC     | 1.10..1.30    |    2.5 | 2× 22 µF MLCC + 4× 1 µF        | `npu-supply`                   |
| BUCKMEM           | PMIC     | 1.10..1.40    |    2.5 | 2× 22 µF MLCC + 4× 1 µF        | `lpddr-vdd2`                   |
| BUCKPERI (1V8)    | PMIC     | 1.80          |    1.5 | 22 µF MLCC + 4× 1 µF           | `vdd-1v8`                      |
| LDO1 (RTC)        | PMIC     | 1.20 (typ)    |    0.1 | 1 µF MLCC                      | `rtc-backup`                   |
| LDO2 (PLL)        | PMIC     | 1.00          |    0.3 | 4.7 µF MLCC + 100 nF           | `vdd-pll-1v0`                  |
| LDO3 (LPDDR VDDQ) | PMIC     | 0.50..0.60    |    0.3 | 4.7 µF MLCC + 100 nF           | `lpddr-vddq`                   |
| LDO4 (DSI AVDD)   | PMIC     | 1.80          |    0.3 | 4.7 µF MLCC + 100 nF           | `dsi-avdd`                     |
| LDO5 (sensors)    | PMIC     | 3.00          |    0.3 | 1 µF MLCC                      | `sensor-3v0`                   |
| LDO6 (WiFi/BT)    | PMIC     | 3.30          |    0.2 | 4.7 µF + 100 nF                | `wifi-3v3`                     |
| LDO7 (audio)      | PMIC     | 3.30          |    0.2 | 4.7 µF + 100 nF                | `audio-3v3`                    |
| LDO8 (display)    | PMIC     | 3.00          |    0.2 | 1 µF MLCC                      | `display-3v0`                  |
| LDO9 (eMMC)       | PMIC     | 3.30          |    0.2 | 4.7 µF + 100 nF                | `emmc-3v3`                     |
| LDO10 (USB PHY)   | PMIC     | 3.30          |    0.3 | 4.7 µF + 100 nF                | `usb-phy-3v3`                  |
| LDO11 (GPS/aux)   | PMIC     | 3.30          |    0.3 | 4.7 µF + 100 nF                | `aux-3v3`                      |

Decoupling budgets assume 100 MHz worst-case noise. Real budgets must be
re-validated per `docs/board/pdn-budget.md` using post-layout S-parameter
extraction or transient SPICE.

## Always-on / wake / sleep domains

- `RTC backup` (LDO1) is on whenever VBAT or USB-PD VBUS is present; it survives
  hardware power-off. Holds RTC + secure-element NVRAM.
- `vsys` is on whenever VBAT > 3.0 V or VBUS is connected.
- All other rails are gated by the PMIC sequencer (`docs/security/boot-image-format.md`
  §3 / `package/pmic/da9063.yaml#power_sequence`).
- Wake sources: PMIC PWR button, USB-PD VBUS attach, RTC alarm, WiFi/BT host-wake.

## Linux device-tree power-domain mapping (sketch)

This is a planning sketch, not a binding. The generated DTS template under
`sw/platform/generated/e1-platform.dtsi` is the authoritative source once the
Linux-capable AP variant lands.

```
pmic@58 {
    compatible = "dlg,da9063";
    interrupt-parent = <&plic>;
    regulators {
        cpu_supply: bcore { regulator-name = "cpu-supply"; ... };
        npu_supply: bpro  { regulator-name = "npu-supply"; ... };
        lpddr_vdd2: bmem { regulator-name = "lpddr-vdd2"; ... };
        vdd_1v8: bperi    { regulator-name = "vdd-1v8";   ... };
        ...
    };
};
```

## Cross-references

- `docs/architecture-optimization/phone-platform.md`
- `docs/architecture-optimization/soc-optimized-operating-point.yaml`
- `package/pmic/da9063.yaml`
- `package/charger/max77860.yaml`
- `package/usb-pd/tps65987.yaml`
- `docs/board/pdn-budget.md`
- `research/mobile_platform_2026/02_analysis/pmic_and_charging.md`
