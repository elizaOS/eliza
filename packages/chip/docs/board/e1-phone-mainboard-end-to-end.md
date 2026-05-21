# E1 Phone Mainboard End-to-End Closure Plan

Status: concept planning, not fabrication evidence.
Date: 2026-05-20.

## Product Target

Build one phone mainboard with a single USB-C port for charge/data/debug,
speakers, microphones, front and rear cameras, display/touch, Wi-Fi,
Bluetooth, GNSS, NFC, and cellular. The first board should use module
boundaries for high-risk radios wherever possible, especially cellular.

The current `board/kicad/e1-phone/` directory is a concept package with a
schematic scaffold, concept PCB, fit reports, and previews. It still needs a
real schematic, routed board layout, local libraries, fabrication outputs, STEP
model, BOM, pick-and-place, SI/PI reports, RF reports, thermal evidence, and
first-article logs before any release claim.

## Proposed Board Metrics

The current single-mainboard concept is optimized around commodity 5.5 inch
1080 x 1920 MIPI display modules because those panels are easier to buy as OEM
LCM/CTP assemblies than newer high-refresh phone panels with controlled supply.
The mechanical anchor is a 68.04 x 120.96 mm active area and roughly 70-71 mm
TFT outline, with the phone enclosure driven by the touch lens and side-key
stack.

- Device envelope: 78.0 x 153.6 x 11.2 mm flush-back body, before enclosure ME tolerance
  stack. This is driven by the selected 77.1 x 151.77 mm commodity CTP module
  plus minimum enclosure margin; a 72 x 148 mm envelope does not contain that
  display assembly.
- Display anchor: 5.5 inch FHD 1080 x 1920 MIPI-DSI, 68.04 x 120.96 mm active
  area.
- Mainboard bounding box: 64 x 132 mm, 8,448 mm2.
- Estimated actual PCB area: 4,990 mm2.
- Battery/non-PCB window: 3,458 mm2.
- PCB utilization of bounding box: 59.1%.
- Estimated unallocated/wasted area in concept placement: 550 mm2, or 11.0%.
- Target after first placement pass: 8-12% unallocated board area.
- First prototype stackup: 8L 0.8 mm HDI minimum.
- Preferred production stackup: 10L 0.8 mm HDI.

The metric source of truth is
`docs/board/e1-phone-mainboard-metrics.yaml`, with 2D display fit generated in
`board/kicad/e1-phone/display-fit.yaml` and concept PCB utilization generated
in `board/kicad/e1-phone/layout-utilization.yaml`. After KiCad placement
exists, replace estimates with computed geometry from the board polygon,
component courtyards, antenna keepouts, no-route zones, and shield-can outlines.

## CAD Preview

The concept preview lives at:

- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.svg`
- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.html`
- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.png`

This is a CAD-style floorplan preview, not routed PCB CAD. It defines the
first placement intent for KiCad: top/bottom antenna keepouts, cellular near
the upper-left RF edge, cameras and display FFCs near the upper-right edge,
SoC/LPDDR/PMIC near the top-center graphite path, side buttons on the left
spine, battery window in the center, and USB-C/audio at the bottom edge.

## Sourcing Baseline

The first sourcing pass deliberately favors modules with marketplace evidence
and public vendor pages over raw chips:

- Display: 5.5 inch 1080 x 1920 MIPI-DSI 4-lane LCM with CTP. Alibaba listings
  for 055WU01-class modules show 40-pin MIPI, 1000 nit typical brightness, and
  68.04 x 120.96 mm active area. Made-in-China listings for Chenghao
  CH550FH01A-CT show 77.1 x 151.77 x 3.39 mm CTP outline, 70.78 x 129.17 x
  1.7 mm TFT outline, 68.04 x 120.96 mm active area, and MIPI interface.
- Rear camera: 13 MP OV13855/OV13850 autofocus MIPI CSI module, 24-30 pin FPC,
  selected only after the vendor provides a pinout, lens stack height, and
  Linux/Android driver plan.
- Front camera: smaller fixed-focus MIPI CSI module chosen by enclosure
  z-height after the rear module is locked.
- Cellular: Quectel RG255C/RM255C 5G RedCap for first integrated phone board;
  RM520N-GL M.2 remains the lab/dev-board fallback for higher-throughput 5G
  bring-up because M.2 modules are easier to socket and replace.
- Wi-Fi/Bluetooth: Murata Type 2EA (LBEE5XV2EA-802) as the phone-class
  Wi-Fi 6E + Bluetooth 5.3 target; current Type 1DX stays as the low-risk
  Linux SDIO/UART fallback.

See `docs/board/e1-phone-oem-sourcing.md` for source links, dimensions, and
open procurement questions.

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

USB-C implementation baseline:

- EVT0: GCT USB4105-class USB2 Type-C receptacle for charge, USB2 data,
  ADB/fastboot/debug, and PD CC handling through TPS65987. This minimizes
  routing risk while the SoC package/PHY decision is still open.
- Production option: Molex 221632/217804 waterproof 24-pin Type-C if USB3 or
  waterproofing becomes a hard requirement and the final package bonds the
  high-speed lanes.
- Mechanical rule: the enclosure must capture connector insertion/removal
  forces; do not rely on solder joints alone.

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

Side-button implementation baseline:

- Use a side-key flex or left-edge switch island for power, volume up, and
  volume down.
- Primary switch family: Panasonic EVQ-P7/P3/9P7 side-push tactile, 3.5 x
  2.9 x 1.35 mm, 0.2 mm travel, phone/portable-device class.
- Power key must be connected to an always-on wake-capable input and support a
  hard reset/long-press path through the PMIC or AON controller.
- Volume keys must be visible to bootloader/recovery before Android starts.

## Enclosure Interface

The current enclosure/PCB interface source of truth is
`docs/board/e1-phone-enclosure-interface.yaml`.

Critical constraints captured there:

- 64 x 132 mm rigid board behind a 5.5 inch FHD display stack and a
  78.0 x 153.6 mm device envelope.
- 64 x 87 mm full-width battery cavity between top and bottom PCB islands.
- Bottom-center USB-C zone at x=26-42 mm, y=124-130 mm.
- Top-island side-key flex connector that must reach the molded side buttons
  without intruding into the full-width battery cavity.
- Top/bottom antenna keepouts that must remain plastic/low-metal unless an RF
  vendor signs off the enclosure stack.
- An 11.2 mm flush-back thickness target that still requires STEP and tolerance-stack
  closure before any enclosure-fit claim.

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
