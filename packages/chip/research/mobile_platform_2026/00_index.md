# Mobile Platform Research Packet (Board, Display, Camera/ISP, Connectivity, PMIC)

Date: 2026-05-19

This packet records a source-backed survey of phone-class platform building
blocks that surround the Eliza E1 SoC: MIPI DSI display, MIPI CSI/ISP camera,
PMIC and USB-PD charging, Wi-Fi 7 / BT 6.0 / 5G modem options, UFS storage,
open-hardware reference phones, KiCad-based PCB tooling, signal/power
integrity practice, sensors, audio subsystem, and thermal/enclosure work.

It is anchored to the existing E1 contracts:

- `docs/arch/display.md` — XR24 framebuffer scaffold and 720x1280 v0 DSI panel target.
- `docs/arch/peripherals.md` — external peripheral scaffold table.
- `docs/arch/wifi.md` — WiFi/BT external module contract (Murata Type 1DX / CYW4343W class).
- `docs/architecture-optimization/phone-platform.md` — coupled-systems work order
  for display, camera, PMIC, USB, storage, radios, sensors.
- `package/e1-demo-pinout.yaml`, `package/bonding/e1_demo_bonding.csv` — current
  QFN64 demo padframe (no DSI/CSI/UFS/USB-PD bonded today).
- `board/kicad/e1-demo/`, `board/fpga/` — current board scaffolding scope.

## Files

- `01_sources/source_inventory.yaml` — provenance, URLs, captured points, and
  claim boundaries. Mirrors the schema used in
  `research/ai_accelerator_sota/01_sources/source_inventory.yaml`.
- `02_analysis/display_dsi_dsc.md` — MIPI DSI-2 v3, D-PHY / C-PHY, Display
  Stream Compression 1.2a/1.3, open DSI controller IP, current LTPO OLED panel
  state, DisplayPort-Alt over USB-C.
- `02_analysis/camera_isp_csi.md` — MIPI CSI-2 v4, open ISP cores (OpenISP,
  CC-Cam, NXP iMX series ISP docs, FPGA ISP projects), V4L2 device tree
  bindings, current Sony LYTIA / Samsung ISOCELL / OmniVision sensor families.
- `02_analysis/pmic_and_charging.md` — Phone PMIC architecture (Qualcomm,
  MediaTek, TI TPS65xxx, Maxim MAX77xxx, Renesas DA9xxx), USB-PD 3.2, PPS,
  EPR, fast-charge protocols, open USB-PD test infrastructure.
- `02_analysis/wifi_bt_modem.md` — 802.11be Wi-Fi 7, BT 6.0 / BLE Audio /
  Auracast, 3GPP Rel-17/18/19 5G modem status, OpenAirInterface and srsRAN
  reality vs commercial closed modems.
- `02_analysis/storage_ufs.md` — JEDEC UFS 4.1, eMMC 5.1 legacy, UFSHCI 4.0,
  M-PHY 5.0, open UFS host controller IP state, NVMe-over-PCIe alternative.
- `02_analysis/open_phone_platforms.md` — Pine64 PinePhone Pro, Purism Librem 5,
  Phone (1)/(2)/(3a), MNT Pocket Reform, EOMA68, Phasma, FairPhone, lessons
  from each open or repair-friendly phone platform.
- `02_analysis/pcb_si_pi.md` — KiCad 9, IPC-2581, IPC-7351, IBIS/IBIS-AMI,
  LPDDR5X routing rules, breakout vias, PDN target impedance, package-board
  co-design.
- `02_analysis/sensors_audio_thermal.md` — IMU (BMI/ICM), barometer,
  magnetometer, ToF, ambient, fingerprint; I2S/TDM codec ICs (TI, Realtek,
  Cirrus), MEMS mic arrays; vapor chamber, phone-class TIM, antenna placement.
- `03_implementation/platform_path_for_e1.md` — High/Med/Low confidence
  recommendations tied to `docs/architecture-optimization/phone-platform.md`,
  `docs/arch/peripherals.md`, `docs/arch/display.md`, `docs/arch/wifi.md`,
  and the v0 DSI / WiFi/BT module gate manifests.

## Claim Boundary

Sources are public papers, vendor product briefs, standards-body abstracts,
and open-source project READMEs. They do not prove E1 implementation status.
Every E1 platform claim still requires the existing contract gates:

- Bonded pins in `package/e1-demo-pinout.yaml` (or a successor padframe).
- A bound module/sensor/panel yaml under `package/` with concrete datasheet.
- A host controller in RTL (DSI TX, CSI-2 RX, SDIO, UFSHCI, USB-PD policy
  engine, I2C/SPI/I2S) and matching cocotb/formal coverage.
- Linux driver, Android service, SELinux policy, and CTS/VTS evidence per
  `docs/architecture-optimization/phone-platform.md`.

This packet is research and planning evidence only. No claim here moves any
existing gate or manifest in `docs/spec-db/`, `docs/evidence/`, or
`package/wifi/evidence-gates.yaml`.
