# Display: MIPI DSI / DSI-2, D-PHY / C-PHY, DSC, Mobile Panels

Date: 2026-05-19

## Standards baseline

- **MIPI DSI-2 v3.0** is the current display-interface contract for phone-class
  panels. DSI-2 differs from legacy DSI v1.3 in mandating support for VESA
  Display Stream Compression (DSC), Command Mode + Video Mode coexistence, and
  Variable Refresh Rate negotiation. The DSI controller is a digital block; the
  PHY is D-PHY or C-PHY.
- **MIPI D-PHY v3.0** runs up to ~9.0 Gbps/lane (v3.5 publicly cited),
  typically 1-4 lanes for phone DSI. Symmetric HS/LP signaling, ULPS for
  panel-off / always-on. Open IP exists for ECP5-class FPGAs (Lattice hardened
  MIPI D-PHY) and as soft IP from OpenCores (`mipi_dsi_tx`).
- **MIPI C-PHY v2.1** uses three-wire trios with 7-symbol-per-16-bit coding,
  reaching ~6.0 Gsym/s/trio (~10.2 Gbps/trio). C-PHY trades wire count for
  lower toggle rate at equivalent bandwidth, useful when EMI matters. C-PHY is
  unlikely to be the right E1 v0 target — D-PHY has more open PHY references.
- **VESA DSC 1.2a / 1.3** is now table-stakes for >FHD panels. DSC 1.2a is the
  baseline that phone-class panels universally accept (3:1 visually lossless,
  block-line buffer model). VESA VDC-M / DSC 1.3 push to finer block formats
  and lower bitstreams but are uncommon in production phones today.

## Phone panel landscape (2026)

- **LTPO 4.0 (Samsung Display, BOE Q+, LG OLED)** — variable-refresh from 1 Hz
  to 120-144 Hz, AOD at 1-10 Hz with native gating, tandem-stack panels with
  4000-6000 nit peak HDR. All require DSC 1.2a on DSI-2.
- **1Q-OLED / Q9+** — current phone-class flagship panels (e.g. 1224x2700
  to 1440x3200 native), still DSI-2 + DSC.
- **Simple-panel-class displays** — Raspberry Pi 7" DSI, generic 720x1280 IPS,
  small AMOLED watch panels. These match the existing E1 v0 contract in
  `docs/arch/display.md` and do not require DSC.

## E1 contract today

`docs/arch/display.md` describes `e1_display` as a minimal scanout scaffold:
`FB_BASE`, `MODE`, `FORMAT` (XR24 only), `ENABLE`, with a fixed-porches timing
generator and a one-word-at-a-time SRAM-coupled framebuffer client. The v0
reference is **720x1280 portrait DSI**, with a panel command sequence driven
by boot firmware from `fw/panel/v0_init.bin`. There is **no DSI controller in
RTL today** — the controller, command FIFO, and DSI PHY are explicit gaps
under `display-real-framebuffer-path`.

## Open DSI / display IP

- **OpenCores `mipi_dsi_tx`** — SystemVerilog DSI TX scaffold, useful as the
  reference for an `e1_dsi_tx` block: short/long packet builder, BTA, LP/HS
  state machines, lane sequencer.
- **Lattice hardened MIPI D-PHY (ECP5/CertusPro NX)** — open-toolchain
  (Yosys/nextpnr/Project Trellis) compatible D-PHY, usable for FPGA DSI
  bring-up before silicon.
- **Linux `drm/panel-simple` + DRM/KMS** — already the assumed Linux side per
  `docs/arch/display.md`. The Android side wants HWC 2.4+ with a DRM/KMS
  backend.
- **Linux `dsi_host` / `mipi-dsi` framework** — required upstream contract for
  DSI command transport. Maps cleanly to a register-level DSI controller in
  `e1` once it exists.

## DisplayPort-Alt over USB-C

Modern phones expose DP 1.4/2.1 over USB-C via Alt Mode. This requires either:

1. A separate DisplayPort source block on die (not in E1), or
2. A DSI-to-DP bridge IC (e.g. Analogix ANX7625, Cadence MHDP) on the board
   driven from DSI.

For E1, option (2) is the only realistic 2026 path. The bridge sits between
the on-die DSI TX and the USB-C connector and is configured by I2C from the
AP. This requires a USB-PD/Alt-Mode controller (see `pmic_and_charging.md`).

## SI/PI for DSI

DSI lanes are differential, 100 ohm, length-matched within each lane and
across lanes (typically <2 mm intra-lane skew, <10 mm inter-lane). HS-TX
common-mode is ~200 mV, LP-TX is single-ended 0-1.2 V — pad cells must
support both modes. Reference: `pcb_si_pi.md`.

## Gaps for E1

| Gap | Required artifact | Status |
| --- | --- | --- |
| DSI controller RTL | `rtl/display/e1_dsi_tx.sv` + cocotb | Missing |
| DSI PHY pad cells | `package/e1-demo-pinout.yaml` DSI bond entries | Not bonded |
| DSC encoder | `rtl/display/e1_dsc_enc.sv` (DSC 1.2a) | Missing |
| Panel command FIFO | DSI command transport, ELP/HS state | Missing |
| DRM/KMS driver | `linux/drivers/gpu/drm/e1/` | Missing |
| Android HWC | HWC 2.4 backend bound to DRM | Missing |

These align with the `phone-platform.md` "Display and graphics" work item.

## High-confidence recommendations

1. Author `package/display/v0-dsi-720x1280.yaml` binding the existing
   `docs/arch/display.md` v0 panel to a concrete simple-panel-compatible
   datasheet, the way `package/wifi/murata-1dx-sdio.yaml` does for WiFi.
2. Land an `e1_dsi_tx` RTL block under `rtl/display/` with cocotb coverage of
   DSI packet structure (short writes, long writes, BTA, LP-to-HS transition)
   before any panel-related claim moves.
3. Defer DSC 1.2a, LTPO command-mode VRR, and DP-Alt bridge work behind the
   above gates. They are real and well-specified but premature for v0.
