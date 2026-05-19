# PMIC Architecture, USB-PD, Fast Charging

Date: 2026-05-19

## Phone PMIC architectures

Modern phone PMICs are split across **AP PMIC** (CPU/NPU/GPU rails, ~12-20
rails), **modem PMIC** (RF / 5G modem, ~6-10 rails), and **RF/connectivity
PMIC** (Wi-Fi, BT, Audio codec rails). The split is by power-island ownership
and by silicon vendor pairing: Qualcomm PMK/PMR/PM, MediaTek MT6363/6373/6377.

### Qualcomm Snapdragon family (reference only — closed)

- **PM8550** — primary AP PMIC for 8 Gen 3 / 8 Gen 4 platforms. SPMI control
  bus. ~18 bucks/LDOs + GPIOs + RTC + watchdog + thermal.
- **PMR735a** — RF PMIC for 5G modem.
- **PMK8550** — companion / always-on PMIC.
- Driver path is Qualcomm SPMI on Linux (`drivers/spmi/`); fully closed
  programming guide; not a viable E1 path.

### MediaTek (closed but partially documented)

- **MT6363 / MT6373 / MT6377** — phone PMICs for Dimensity 9x00/8x50.
  Documented at block-diagram level only.

### TI TPS65xxx / Maxim MAX77xxx / Renesas DA9xxx (open driver paths)

These are the realistic E1 PMIC options because they have public datasheets
and mainline Linux drivers.

- **TI TPS6593-Q1** — 5 bucks + 8 LDOs + GPIO + ESM/WDT, I2C/SPI control.
  Targeted at automotive but suitable for AP-class designs. Mainline
  `drivers/mfd/tps6594-*`.
- **TI TPS65987DDH / TPS65988** — USB-C/PD 3.0 source/sink with PPS support,
  OTP-programmable policy. Sits beside the PMIC as the USB-PD policy engine.
- **Maxim MAX77860** — USB-C + USB-PD charger, 3 A switching, OTG. Single-chip
  charger suitable for handset designs. Mainline `drivers/power/supply/`.
- **Maxim MAX20303** / **MAX20355** — single-chip phone PMICs targeting
  wearables/handsets.
- **Renesas / Dialog DA9063 / DA9061 / DA9062** — multi-rail PMICs with full
  mainline support (`drivers/mfd/da9063-*`). DA9063 is the **PinePhone Pro
  reference PMIC**, which is the most relevant open precedent: 12 rails, I2C
  control, RTC, watchdog, Linux power-domain glue all working.
- **Rockchip RK809 / RK806** — companion PMICs for RK3399/RK3588 with
  mainline drivers. Open phone precedent on PinePhone Pro.

## E1 PMIC strategy (high-confidence)

Pair the existing E1 padframe with a **two-chip PMIC split**:

1. **Main PMIC**: DA9063 or RK806 class — 6-12 rails, I2C, mainline driver.
   Owns CPU / NPU / DDR / IO / always-on rails.
2. **USB-PD + charger**: TI TPS65987DDH (PD policy) + MAX77860 or BQ25895
   (battery charger), both with mainline drivers and public programming
   guides.

This mirrors PinePhone Pro almost exactly and inherits its Linux/Android
software readiness.

## USB-PD 3.2 / PPS / EPR

- **USB PD 3.2** (2023-2024) — Extended Power Range up to 240 W (48 V * 5 A),
  Programmable Power Supply (PPS) for fine-grained voltage control,
  Adjustable Voltage Supply (AVS) for ultra-fast renegotiation. Phone use
  cases primarily exercise PPS (3.3-21 V, 20 mV step) for fast charging.
- **Type-C 2.3** — connector + e-marker + 240 W cable contract. Alt Mode
  discovery for DisplayPort and Thunderbolt 4.
- **USB4 v2.0** — 80 Gbps asymmetric, DP 2.1 tunneling. Out of scope for E1
  v0 — requires USB4 PHY which is far beyond a v0 padframe.

### Fast-charge protocols (proprietary, mostly closed)

- **Qualcomm Quick Charge 5** — PD-PPS-compatible at the wire level but
  requires QC5 negotiation in firmware. Closed.
- **Oppo/OnePlus SuperVOOC / SUPERVOOC 2.0** — 100-240 W proprietary;
  closed.
- **Samsung Super Fast Charge 2.0** — PD-PPS at heart; documented enough to
  interoperate.
- **MediaTek Pump Express** — proprietary.

For E1, the only realistic option is **USB-PD 3.2 + PPS**, leveraging the
TPS65987DDH policy engine and a standard buck charger. Proprietary fast-charge
modes are out of scope.

## Open USB-PD test infrastructure

- **Cynthion** (Great Scott Gadgets) — open USB analyzer with FPGA fabric,
  capable of capturing PD CC-line traffic.
- **Tigard** — open multi-protocol debug board (UART/SPI/I2C/JTAG). Not PD
  specific.
- **Glasgow Interface Explorer** — open hardware lab tool with applet
  framework; PD applet community contributions exist.
- **PD Buddy Sink** — open hardware USB-PD sink for lab use.

These are useful for **E1 PD bring-up traces** (CC-line capture, PE state
machine validation).

## Power rail / current budget (E1 14A-class AP)

Indicative rail map for an E1 phone build (numbers are budgets, not silicon
measurements):

| Rail | Voltage | Peak current | Owner |
| --- | ---: | ---: | --- |
| VDD_CPU_NPU | 0.7-0.9 V | 8-14 A | Main PMIC buck (multi-phase) |
| VDD_GPU | 0.7-0.9 V | 4-6 A | Main PMIC buck |
| VDD_SOC | 0.75 V | 1-2 A | Main PMIC buck |
| VDD_LPDDR5X_VDD2 | 1.05 V | 1-2 A | Main PMIC buck |
| VDD_LPDDR5X_VDDQ | 0.5 V | 0.5-1 A | Main PMIC LDO |
| VDDIO_1V8 | 1.8 V | 0.5-1 A | Main PMIC LDO |
| VDD_PHY_DSI/CSI | 1.2/2.5 V | <0.5 A | LDOs |
| VDD_USB | 3.3/1.2/0.9 V | <0.5 A | LDOs |
| VDD_WIFI/BT | 3.3/1.8 V | 1-2 A peak | LDO + buck |
| VBAT | 3.3-4.4 V | 5-12 A | Battery |

Peak system current at full NPU + GPU + radio is the dominant SI/PI
constraint — see `pcb_si_pi.md` for PDN target impedance.

## Gaps for E1

| Gap | Required artifact | Status |
| --- | --- | --- |
| PMIC selection | `package/pmic/<part>.yaml` | Missing |
| USB-PD policy engine binding | `package/usb-pd/tps65987.yaml` | Missing |
| Power tree diagram | `docs/board/power-tree.md` | Missing |
| Linux power-domain driver | `linux/arch/.../e1-pmic.dtsi` | Missing |
| Android power HAL | health@2.1 + power@2.0 bindings | Missing |
| Battery fuel gauge | `package/pmic/<fuel-gauge>.yaml` | Missing |

## High-confidence recommendations

1. **Pick DA9063 or RK806 as the v0 main PMIC.** Both have mainline drivers
   and open precedent (PinePhone Pro). Author `package/pmic/da9063.yaml`
   binding rails to E1 power islands.
2. **Pick TPS65987DDH + MAX77860 (or BQ25895) for the USB-PD + charge path.**
   Both have mainline drivers. Author `package/usb-pd/tps65987.yaml`.
3. **Defer Quick Charge 5 / SuperVOOC / proprietary modes.** USB-PD 3.2 + PPS
   is sufficient and standards-compliant.
4. **Author a power tree before any board work.** `docs/board/power-tree.md`
   with rail names, voltage, peak current, and owner. Cross-check against
   `package/e1-demo-pinout.yaml` for required power pin counts.
