# Platform Path for E1 — Recommendations Tied to Existing Contracts

Date: 2026-05-19

This document maps every research finding in `02_analysis/` to a concrete
move on the existing E1 contracts. It is **planning evidence**, not a
contract change. No claim here moves any existing gate or manifest.

## Anchor contracts

- `docs/architecture-optimization/phone-platform.md` — coupled platform
  systems work order (display, camera, PMIC, USB, storage, radios,
  sensors).
- `docs/arch/display.md` — XR24 framebuffer scaffold and 720x1280 v0 DSI
  panel target.
- `docs/arch/peripherals.md` — external peripheral scaffold table.
- `docs/arch/wifi.md` — WiFi/BT external module contract.
- `package/e1-demo-pinout.yaml` + `package/bonding/e1_demo_bonding.csv` —
  current QFN64 demo padframe (no DSI/CSI/UFS/USB-PD/I2S bonded today).
- `package/wifi/evidence-gates.yaml` — gating manifest pattern to mirror
  for every new platform interface.

## High-confidence recommendations (implement in repo)

### H-1. Author panel binding yaml under `package/display/`

Mirror `package/wifi/murata-1dx-sdio.yaml` pattern. Create
`package/display/v0-dsi-720x1280.yaml` binding the existing
`docs/arch/display.md` v0 panel to a concrete simple-panel datasheet,
with required board signals, voltage rails, reset sequencing, evidence
gates. Required before any panel-related claim moves.

### H-2. Author WiFi/BT module datasheet binding completion

`package/wifi/murata-1dx-sdio.yaml` exists as a scaffold; complete it with
the exact Murata Type 1DX FCC ID, firmware filename (`brcmfmac4343w-sdio.bin`),
NVRAM filename, and pin mapping to the future bonded WIFI_* signals.

### H-3. Pick PMIC + USB-PD parts and author yaml bindings

- `package/pmic/da9063.yaml` — Renesas/Dialog DA9063 rail-to-power-island
  binding. Mirrors PinePhone Pro pattern. Mainline driver
  `drivers/mfd/da9063-*`.
- `package/usb-pd/tps65987.yaml` — TI TPS65987DDH PD policy engine. PPS
  3.3-21 V, 20 mV step.
- `package/charger/max77860.yaml` — Maxim MAX77860 USB-C charger or BQ25895
  alternative.

### H-4. Author `docs/board/power-tree.md`

Rail-by-rail power tree with: rail name, voltage, peak current, decoupling
budget, owner (PMIC vs LDO vs always-on), Linux power-domain name. Required
before any board layout work.

### H-5. Author `docs/board/pdn-budget.md`

PDN target impedance per rail per the `pcb_si_pi.md` analysis. Numbers tied
to `docs/architecture-optimization/soc-optimized-operating-point.yaml`.

### H-6. Author `docs/board/antenna-plan.md`

Antenna placement for Wi-Fi/BT (2.4/5 GHz PIFA), GNSS (chip antenna), NFC
loop. Defer cellular, UWB, mmWave to post-v0.

### H-7. Author `docs/board/thermal-stack.md`

Graphite + gap-filler thermal stack for v0. Vapor chamber listed as v1
upgrade pending silicon power measurement.

### H-8. Author `package/sensors/v0-sensors.yaml`

Concrete sensor BOM: BMI323 IMU + BMP390 baro + AK09918 mag + TSL2591
ALS/prox, all mainline-driven, all I2C/I3C. Bind to future bonded I2C
pins.

### H-9. Author `package/audio/v0-codec.yaml`

Concrete codec BOM: Realtek ALC5688 or TI TLV320AIC3204 + Cirrus CS35L41
smart amp + two Knowles SPH0641LM4H PDM mics. Bind to future bonded I2S
+ PDM pins.

### H-10. Commit to KiCad 9 + IPC-2581 + kibot CI

Add `board/kicad/e1-phone/` skeleton schematic and a `kibot.yaml` for
automated Gerber + IPC-2581 + BOM + STEP generation. Mirror MNT Reform
and PinePhone Pro repo layouts.

## Medium-confidence recommendations (specify but defer)

### M-1. CSI-2 RX RTL + open V4L2 driver path

Document the gap and pick a sensor target (OmniVision OV5640 or OV13B
class for open-driver path). Defer RTL until display path lands and
padframe has CSI pins.

### M-2. eMMC 5.1 host (SDHCI-class)

`rtl/io/e1_sdhci.sv` after WiFi SDIO RTL lands (shares the same SDHCI
core for both). UFS is post-v0.

### M-3. DSI controller RTL (`e1_dsi_tx`)

Closes the `display-real-framebuffer-path` gap noted in
`docs/arch/display.md`. Required before v0 panel claim can move.
Mirror OpenCores `mipi_dsi_tx` as the reference.

### M-4. SoM/mainboard split (MNT Pocket Reform pattern)

Document `package/som-vs-mainboard-split.md` describing what lives on
E1 SoM (SoC, LPDDR5X, eMMC, main PMIC) vs mainboard (USB-PD, charger,
WiFi/BT module, display/camera FFC, sensors, audio codec, battery, button
matrix).

### M-5. External LTE modem path (post-v0)

Document Quectel EG25-G / RM520N-GL attach via USB 2.0 + UART. Confirm
ModemManager + qmi_wwan support. Defer 5G.

## Low-confidence / requires human decision

### L-1. Wi-Fi 7 + BT 6 upgrade path

Requires PCIe root complex on die (not in E1 v0 plan), different module
class (mt7925 M.2), and Wi-Fi 7 driver maturity. Worth tracking; not
worth building for v0.

### L-2. Display Stream Compression (DSC 1.2a) RTL

Real and well-specified, but premature for a 720x1280 v0 panel. Required
for any > FHD LTPO OLED panel later.

### L-3. Open ISP RTL

OpenISP / openasic-org openISP exist but are not silicon-proven. The
realistic open-camera path for v0 is libcamera + CPU-side processing of
RAW frames, deferring ISP RTL. Track for v1.

### L-4. Vapor chamber thermal upgrade

Decide based on measured silicon power. Not a v0 commitment.

### L-5. Custom PMIC

Tempting but every open-phone team that tried this stalled. Stay with
DA9063 / RK806 class for v0.

### L-6. Fingerprint subsystem

Closed-firmware ecosystem. Decide whether to accept a closed Goodix /
Synaptics part or omit fingerprint entirely. Not a v0 blocker.

## Cross-references

- Display work expands the contract in `docs/arch/display.md` and the
  pending DSI controller (`display-real-framebuffer-path` gap).
- Camera work matches the "Camera" section of
  `docs/architecture-optimization/phone-platform.md`.
- PMIC / USB / sensor / audio / radio work matches the "PMIC and platform
  IO" section of `phone-platform.md`.
- Every recommendation above should land with a fail-closed gate manifest
  in the style of `package/wifi/evidence-gates.yaml`. No platform claim
  moves without bonded pins, host-controller RTL, cocotb coverage, Linux
  driver, Android service, and CTS/VTS subset evidence.
