# E1 Phone Mainboard End-to-End Closure Plan

Status: concept planning, not fabrication evidence.
Date: 2026-05-20.

## Product Target

Build one phone mainboard with a single USB-C port for charge/data/debug,
speakers, microphones, front and rear cameras, display/touch, Wi-Fi,
Bluetooth, GNSS, NFC, and cellular. The first board should use module
boundaries for high-risk radios wherever possible, especially cellular.

The current `board/kicad/e1-phone/` directory is only a KiCad skeleton. It
needs a real schematic, board layout, local libraries, fabrication outputs,
STEP model, BOM, pick-and-place, SI/PI reports, RF reports, thermal evidence,
and first-article logs before any release claim.

## Proposed Board Metrics

The initial single-mainboard concept is a rigid PCB with top and bottom
component islands and a side spine around the battery window.

- Device envelope: 72 x 152 x 9.5 mm.
- Mainboard bounding box: 68 x 138 mm, 9,384 mm2.
- Estimated actual PCB area: 6,088 mm2.
- Battery/non-PCB window: 3,296 mm2.
- PCB utilization of bounding box: 64.9%.
- Estimated unallocated/wasted area in concept placement: 958 mm2, or 15.7%.
- Target after first placement pass: 8-14% unallocated board area.
- First prototype stackup: 8L 0.8 mm HDI minimum.
- Preferred production stackup: 10L 0.8 mm HDI.

The metric source of truth is
`docs/board/e1-phone-mainboard-metrics.yaml`. After KiCad placement exists,
replace these estimates with computed geometry from the board polygon,
component courtyards, antenna keepouts, no-route zones, and shield-can
outlines.

## CAD Preview

The concept preview lives at:

- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.svg`
- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.html`
- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.png`

This is a CAD-style floorplan preview, not routed PCB CAD. It defines the
first placement intent for KiCad: RF at the top edge, cameras near the top
right, SoC/LPDDR/PMIC near the top-center thermal path, cellular on the top
left with antenna keepouts, battery window in the center, and USB-C/audio at
the bottom edge.

## Required Hardware Blocks

### Core Compute

- E1 SoC package, vendor drawing, pinout, padframe, ESD cells, bond diagram,
  and package electrical/thermal model.
- LPDDR4X/LPDDR5X memory package or PoP decision, length matching rules,
  power rails, impedance constraints, and memory training evidence.
- eMMC/UFS storage decision, boot straps, write-protect/reset, partition map,
  recovery path, and storage integrity test.
- Secure boot storage, lifecycle/debug lock, key provisioning, and factory
  debug unlock procedure.

### Power

- One USB-C receptacle with ESD, CC protection, USB2 data, optional USB3,
  and mechanical reinforcement.
- USB-PD controller, charger, PMIC, load switches, ideal diode or power-path,
  fuel gauge, battery connector, pack NTC, board NTCs, and hard power button.
- Rail sequencing for AP, NPU, memory, display, cameras, RF, audio, sensors,
  storage, and always-on domains.
- Per-rail current limits for first article and production test.
- Efficiency targets in `e1-phone-mainboard-metrics.yaml`.

### Thermal

- Package-to-spreader stack: SoC TIM, graphite, optional vapor chamber, gap
  pad, and back-cover thermal path.
- NTC near SoC/AP cluster, NTC near modem/RF or PMIC hot zone, and skin-temp
  NTC near the back cover.
- Thermal HAL policy that throttles CPU, NPU, display, charger, and modem
  before skin temperature exceeds 43 C.
- 30-minute sustained CPU+NPU+camera+modem thermal soak with IR images and
  synchronized power/frequency/thermal traces.

### Radios

- Cellular: use a certified 5G module for first hardware. In 2026 the latest
  flagship modem-RF reference is Qualcomm X105, which Qualcomm describes as
  3GPP Release 19 ready with 5G Advanced, NR-NTN, 14.8 Gbps peak downlink,
  4.2 Gbps peak uplink, and a 6 nm RF transceiver. For a product board, select
  a module with carrier and regional certification support rather than raw RF
  silicon unless there is a dedicated RF/carrier team.
- Wi-Fi/Bluetooth: current repo binding uses Murata Type 1DX. For a latest
  phone-class SKU, re-evaluate Wi-Fi 7/8 + Bluetooth 6 module options and
  decide whether to keep the conservative module or move to a newer PCIe/UART
  module.
- GNSS: decide whether cellular module integrated GNSS is enough or add a
  discrete GNSS/LNA path.
- NFC: add NFC controller, matching network, secure-element policy if needed,
  and loop antenna geometry.
- Antennas: top/bottom diversity antennas, cellular main/diversity/MIMO feeds,
  Wi-Fi/BT antenna, GNSS antenna, NFC loop, coax or printed feeds, pi networks,
  U.FL bring-up points, shield cans, and SAR/RF exposure test plan.

### Multimedia And I/O

- Display panel connector, MIPI DSI lanes, reset, TE, backlight enable/PWM,
  panel bias rails, touch controller, touch IRQ/reset, and ESD.
- Two cameras: rear and front sensors, MIPI CSI lanes, clocks, reset, power
  enables, autofocus/flash if supported, privacy LED/policy, calibration, and
  Android Camera HAL or V4L2 evidence.
- Audio codec, smart amp, earpiece speaker, loudspeaker, at least two MEMS
  microphones, headset decision, jack detect if headset exists, acoustic
  chamber/mechanical gasket plan, and ALSA/Android Audio HAL logs.
- Buttons, haptics driver and actuator, IMU, magnetometer, barometer,
  ambient/proximity sensors, fingerprint decision, board ID straps, and
  service/test pads.

## Required Analyses Before Layout Release

- Board stackup with impedance coupons and vendor capability letter.
- SI simulation for MIPI DSI/CSI, USB, memory, SDIO/PCIe, clocks, reset,
  debug, and high-speed modem links.
- PI simulation for every PMIC rail, including package/die decap assumptions,
  capacitor anti-resonance, regulator loop stability, and load-step behavior.
- RF layout review for antenna keepouts, coax paths, matching networks,
  coexistence, desense, SAR, and ground discontinuities.
- Thermal simulation tied to measured or post-route power, not estimates.
- DFM/DFA review for board outline, copper-to-edge, via-in-pad, HDI stack,
  stencil, assembly side constraints, shield cans, connector rework, AOI,
  X-ray, and depanelization.

## Required Bring-Up Evidence

- Power-off resistance check and controlled first power-on current logs.
- USB-C attach, PD negotiation, charge-cycle, and ADB/fastboot transcripts.
- Rail boot, idle, suspend, resume, and worst-case captures.
- Boot ROM, OpenSBI/Linux or Android boot, storage, and recovery logs.
- Display, touch, camera, audio, sensors, haptics, Wi-Fi, Bluetooth, cellular,
  GNSS, NFC, thermal, and suspend/resume transcripts.
- RF VNA/S11, conducted power, radiated pre-scan, coexistence, SAR pre-scan.
- Factory test transcript covering serial/MAC/IMEI/key provisioning, calibration
  blobs, labels, debug lock, rework, retest, and quarantine.

## External Source Notes

- Qualcomm X105 source: Qualcomm press release and product page, March 2026.
- Qualcomm X85/X80 remain relevant fallback modem-RF references if X105 module
  availability or carrier support is not ready.
- Module vendor availability, carrier approvals, and region bands must be
  refreshed before schematic freeze.
