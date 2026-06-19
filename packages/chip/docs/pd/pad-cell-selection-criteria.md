# Pad cell selection criteria

This document defines the pad-cell and ESD requirements that any candidate PDK
must satisfy before the `eliza_e1_demo` chip can be hardened against it.
It is intentionally foundry-agnostic. A foundry/PDK selection is a separate,
gated decision tracked in `docs/manufacturing/release-manifest.yaml`.

The padframe contract this matrix has to satisfy is
`pd/padframe/e1_demo_padframe.yaml`, and the pinout it has to drive is
`package/e1-demo-pinout.yaml` (64 pins, 3.3 V IO, 1.8 V core).

## 1. Required pad classes

Every candidate PDK must supply, as native foundry cells, at minimum:

| Class                | Count (min) | Notes                                                 |
| -------------------- | ----------- | ----------------------------------------------------- |
| Core VDD pad         | 4           | 1.8 V core domain.                                    |
| Core VSS pad         | 4           | Core ground; tied to common substrate plan.           |
| IO VDD pad           | 5           | 3.3 V IO domain.                                      |
| IO VSS pad           | 5           | IO ground; separated from core where PDK requires.    |
| Digital input pad    | as needed   | CMOS threshold, optional pull-up/down.                |
| Schmitt input pad    | 1+          | Required for `RST_N`; optional for `CLK_IN`.          |
| Clock input pad      | 1           | Low-jitter input buffer for `CLK_IN`.                 |
| Digital output pad   | as needed   | 4 mA and 8 mA drive variants required.                |
| Bidirectional pad    | reserved    | Reserved for future JTAG/scan extension; not used in v0. |
| Corner pad           | 4           | One per padring corner; ESD-stitching.                |
| Power clamp / ESD pad| 1 per rail  | HBM/CDM clamp on every supply pair.                   |
| No-connect / filler  | as needed   | For unused QFN64 sites and padring spacing.           |

Tie-high/tie-low cells must be available in the standard-cell library, not the
padframe; they are referenced here only because `TEST_MODE` and unused JTAG
inputs are strapped through them inside the wrapper.

## 2. Drive and slew options

The pinout asks for two output drive strengths:

- `4 mA` for low-fanout debug/IRQ/JTAG outputs (`DBG_RDATA*`, `DBG_READY`,
  `IRQ_*`, `JTAG_TDO`).
- `8 mA` for the LED bank (`GPIO0..7`).

A candidate PDK must therefore expose at least two drive-strength variants per
output pad, and must offer either a slew-controlled variant or a programmable
slew bit so that the LED outputs can be slowed down for EMC on the board.
Per-pin slew control is not required.

## 3. ESD targets

The demo chip is a low-volume bring-up part; production-grade ESD is not a
requirement, but minimum survivable thresholds must be documented before the
shuttle is committed.

| Model | Target       | Rationale                                                     |
| ----- | ------------ | ------------------------------------------------------------- |
| HBM   | >= 2 kV      | JEDEC JS-001 Class 2; covered by all open-shuttle PDKs.       |
| CDM   | >= 250 V     | JEDEC JS-002 Class C2a; minimum for handling in a probe lab.  |
| MM    | not required | MM is largely deprecated. Document as "not characterised".    |

Each candidate PDK row in the decision matrix must cite the foundry datasheet
or shuttle documentation that backs these numbers.

## 4. Open-shuttle PDK candidates

These are the open-source / no-NDA-required PDKs that can host the demo chip
without a foundry MSA. They are listed so that the chip can move forward in
documentation form while a real shuttle decision is parked.

| PDK                       | Node          | Pad library         | Open-shuttle path        | Notes                                                                  |
| ------------------------- | ------------- | ------------------- | ------------------------ | ---------------------------------------------------------------------- |
| SkyWater Sky130           | 130 nm        | `sky130_fd_io`      | Efabless / Tiny Tapeout  | Mature open IO cells, documented HBM 2 kV; 3.3 V IO and 1.8 V core fit.|
| GlobalFoundries GF180MCU  | 180 nm        | `gf180mcu_fd_io`    | IHP/Google MPW           | Open IO library; 5 V option useful headroom; less mature than Sky130.  |
| IHP SG13G2                | 130 nm BiCMOS | `ihp_sg13g2_io`     | IHP open PDK             | Open IO subset; BiCMOS unused but available.                           |

## 5. Closed/foundry PDK candidates (deferred)

Listed only to make the decision explicit; selecting any of these is a
release-blocking foundry decision and is out of scope for this commit.

- TSMC 65 nm / 28 nm - requires NDA, foundry IO cells, foundry ESD signoff.
- Samsung 28 nm - same.
- UMC 55 nm / 40 nm - same.

## 6. Decision matrix

The selection across PDKs is scored on the following weighted axes. A row is
filled in once a PDK is being seriously evaluated; until then the column is
left blank.

| Axis                                            | Weight | Sky130  | GF180   | SG13G2  | Notes                                                |
| ----------------------------------------------- | ------ | ------- | ------- | ------- | ---------------------------------------------------- |
| IO voltage covers 3.3 V                         | hard   | yes     | yes     | yes     | Hard requirement; any "no" disqualifies.             |
| Core voltage 1.8 V available                    | hard   | yes     | yes     | yes     | Hard requirement.                                    |
| HBM >= 2 kV documented                          | hard   | yes     | yes     | uncited | Must be cited from foundry docs.                     |
| CDM >= 250 V documented                         | hard   | yes     | uncited | uncited |                                                      |
| Native Schmitt input pad                        | high   | yes     | yes     | uncited | Required for `RST_N`.                                |
| Two output drive strengths                      | high   | yes     | yes     | uncited |                                                      |
| Corner pad cell available                       | high   | yes     | yes     | uncited |                                                      |
| Open-source flow (OpenLane/OpenROAD) supported  | high   | yes     | yes     | partial | Drives the rest of the signoff chain.                |
| No NDA required                                 | high   | yes     | yes     | yes     | Keeps the project openly auditable.                  |
| Foundry shuttle frequency                       | med    | high    | med     | low     |                                                      |
| Per-pin pull-up/down option                     | med    | yes     | yes     | uncited |                                                      |
| Cost per mm^2 on shared shuttle                 | med    | low     | low     | low     |                                                      |
| Production-grade ESD (HBM 4 kV / CDM 500 V)     | low    | no      | partial | no      | Demo chip only; not required.                        |

A PDK is eligible only if every `hard` axis is `yes` and every `high` axis is
`yes` or has a credible mitigation. The first eligible PDK to also clear a
package-vendor and bonding-house quote becomes the default.

## 7. Required artifacts before PDK lock-in

Before a row in this matrix is converted into a foundry decision, the
following must be checked in:

- Datasheet excerpt or shuttle doc for every cited ESD/drive/Schmitt claim.
- Padframe LEF/Liberty for the candidate IO library, vendored under the PDK
  install path used by `make pd-signoff-check`.
- A padframe-inclusive trial DRC/LVS run archived under `build/pd/signoff/`.
- An updated `docs/pd/signoff-evidence-template.md` checklist instance.
- An updated `docs/manufacturing/release-evidence-template.md` manifest
  instance with package vendor, bonding house, and PDK version filled in.

Until those artifacts exist, the `padframe_release`, `package_release`, and
`board_fabrication_release` gates in
`pd/padframe/e1_demo_padframe.yaml` remain blocked.
