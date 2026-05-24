# e1-phone supplier pinouts (public-datasheet evidence)

This directory captures the **public supplier pinouts** for every e1-phone
board component named in `preliminary-bom.yaml` / `pinout-footprint-freeze.yaml`.
Files here are tagged `evidence_class: public_supplier_datasheet` — they are
**not** production-release evidence. Production release additionally requires
the toolmaker / FAI signoff captured under
`board/kicad/e1-phone/production/reports/pinout-review/<function>.yaml` per
`supplier-to-kicad-evidence-map.yaml`.

## Captured pinouts (21)

| # | File | Part | Manufacturer | Status |
|---|------|------|--------------|--------|
| 0 | `compute-som-pinout.yaml` | Core-3566JD4 RK3566 compute SoM (260-pin SODIMM) | Firefly | full per-pin SODIMM signal map published in public datasheet |
| 1 | `gct-usb4105-pinout.yaml` | USB4105-GF-A USB-C 2.0 receptacle, 24 positions | GCT | full pin table (USB-IF Type-C standard) |
| 2 | `quectel-rg255c-pinout.yaml` | RG255C-GL 5G RedCap LGA | Quectel | full public 1-204 pin table captured from RG255C-GL Hardware Design; final regional SKU pack still required |
| 3 | `murata-type-2ea-pinout.yaml` | LBEE5XV2EA-802 Wi-Fi 6E + BT 5.3 (Type 2EA) | Murata | full public 1-199 terminal table captured from Rev. 14 datasheet; development footprint uses Murata public DXF land pattern |
| 4 | `esim-mff2-pinout.yaml` | MFF2 eSIM/eUICC, 8-pad QFN/MFF2 | Multiple eUICC suppliers | full public MFF2 1-8 pin table and nominal package dimensions |
| 5 | `panasonic-evq-p7-pinout.yaml` | EVQ-P7A01P side-push SMT tactile switch | Panasonic | full mechanical/electrical, 4-terminal layout |
| 6 | `ov13855-pinout.yaml` | OV13855 13MP rear MIPI camera module (Sincere First SF-XR3855A class) | OmniVision / Sincere First | canonical 24-pin signal set; per-pin FPC order via signed drawing |
| 7 | `gc5035-pinout.yaml` | GC5035 5MP front MIPI camera module (Sincere First SF-G5035S60FY class) | GalaxyCore / Sincere First | canonical 30-pin connector class signal set; per-pin FPC order via signed drawing |
| 8 | `chenghao-ch550fh01a-pinout.yaml` | CH550FH01A-CT 5.5" FHD MIPI DSI + PCAP display module | Shenzhen Chenghao | canonical 40-pin signal set; per-pin FPC order via signed spec |
| 9 | `battery-pack-4pin-pinout.yaml` | LP566487-class 1S LiPo pack connector | LiPol Battery / custom pack supplier class | board-side 4-signal pack contract captured; exact supplier connector orientation still requires RFQ drawing |
| 10 | `audio-codec-qfn48-pinout.yaml` | ALC5688-class audio codec and companion smart-amp development contract | Realtek / Cirrus Logic development audio function class | board-side audio signal contract captured; selected codec package pin table still required |
| 11 | `backlight-bias-qfn24-pinout.yaml` | LP8556-class display backlight/bias power development contract | Texas Instruments development function class | board-side display bias/backlight signal contract captured; selected driver pin table still required |
| 12 | `fuel-gauge-wlcsp12-pinout.yaml` | BQ27421-class single-cell Li-ion fuel gauge development contract | Texas Instruments development function class | board-side fuel-gauge signal contract captured; selected gauge ball map still required |
| 13 | `haptic-driver-wlcsp9-pinout.yaml` | DRV2605L-class LRA/ERM haptic driver development contract | Texas Instruments development function class | board-side haptic signal contract captured; selected driver ball map still required |
| 14 | `usim-esd-levelshift-pinout.yaml` | TXS4555-class SIM interface supply/level-shift development contract | Texas Instruments development function class | board-side USIM signal contract captured; selected level-shift/ESD pin table still required |
| 15 | `nfc-controller-qfn32-pinout.yaml` | PN7160-class NFC controller development contract | NXP development function class | board-side NFC signal contract captured; selected controller package reconciliation still required |
| 16 | `nfc-loop-match-5pad-pinout.yaml` | PN7160-class NFC antenna loop matching network development contract | NXP development function class | board-side NFC loop match contract captured; antenna tuning and exact values still required |
| 17 | `sensor-hub-qfn24-pinout.yaml` | LSM6DSO-class always-on sensor hub development contract | STMicroelectronics development function class | board-side sensor-hub signal contract captured; selected sensor package pin tables still required |
| 18 | `hirose-bm28-pinout.yaml` | DF40C-80DP-0.4V(51) 80-pos 0.4 mm B2B (BM28 family equivalent) | Hirose | full mechanical, dual-row A1-A40 / B1-B40, signal assignment carried by flex |
| 19 | `tps65987-pinout.yaml` | TPS65987DDH USB-PD 3.1 controller, 56-pin QFN | Texas Instruments | interface groups verified; per-pin QFN table via TI datasheet PDF / .bsdl |
| 20 | `max77860-pinout.yaml` | MAX77860EWG+ USB-C buck charger, 81-bump WLP | Analog Devices (Maxim) | full public A1-J9 bump map captured from ADI datasheet |

For files where `pins: [{pin: ALL, name: fetch_required, ...}]`, the **public
vendor page confirms the package, pin count, and interface groups**, but the
**per-pin coordinate table** is in a binary PDF figure or behind a partner
portal and must be re-emitted with full per-pin entries before the
corresponding `pinout-review/<function>.yaml` signoff can flip to ready.

## Compute / application processor — RESOLVED (public SoM connector pinout)

The compute SoC was previously the **only** NDA-gated line on the e1-phone BoM:
a bare Unisoc T606 (UMS9230) BGA ball-map ships only inside Unisoc's NDA'd
Reference Design Kit, so the board could not be built from public data.

**This blocker is retired.** A bare application-processor BGA *always* needs an
NDA — that is intrinsic to buying a raw AP. The standard way to make a phone
buildable from public data is to source the AP role as a turnkey
**System-on-Module** that bundles SoC + LPDDR + eMMC + PMIC and exposes a
**publicly documented board-to-board connector**. The e1-phone now does exactly
that:

### Compute sourced as Firefly Core-3566JD4 (RK3566 SoM) — public connector pinout

- **Part:** Firefly `Core-3566JD4`, Rockchip RK3566 quad-core Cortex-A55 +
  Mali-G52 + 1 TOPS NPU, LPDDR4 (1-8 GB) + eMMC (8-128 GB) on-module.
- **Carrier interface:** single **260-pin gold-finger SODIMM** edge connector,
  0.5 mm pitch. The **full per-pin signal table is published in the public
  Core-3566JD4 specification PDF** — no NDA, no partner portal.
- **Public docs:**
  [datasheet PDF](https://download.t-firefly.com/Spec/CoreBorads/Core-3566JD4_Specification_EN.pdf),
  [product page](https://en.t-firefly.com/product/core/core3566jd4.html),
  [wiki + schematics + BSP](https://wiki.t-firefly.com/en/Core-3566JD4/),
  plus Rockchip's public RK3566 datasheet and Hardware Design Guide.
- **Captured here:** `compute-som-pinout.yaml`
  (`evidence_class: public_som_connector_pinout`) — power rails, MIPI-DSI x2,
  4-lane MIPI-CSI, USB2/USB3, PCIe 2.1, SDIO (Wi-Fi/BT), I2C/UART/SPI/ADC,
  boot/recovery/reset.
- **Buyable today:** ~$49 single-qty (2 GB/32 GB) at IndustryPC/Firefly Store;
  also listed on Alibaba. MOQ 1.
- **e1-phone fit:** DSI0 drives the 5.5" panel, CSI feeds rear 13 MP + front
  5 MP, the Quectel RG255C 5G RedCap modem attaches over USB2.0 HOST/OTG, and
  the Murata Type-2EA Wi-Fi/BT uses SDIO (SDMMC1) + UART. All AP-role interfaces
  are on the public connector map.

**Honest scope of the resolution:** going to a *bare* RK3566 (or T606) SoC on
the e1-phone PCB later — the cost-down-at-scale path — still requires that
vendor's NDA'd Hardware Design Guide for the BGA ball-map (Rockchip's is far
more openly mirrored than Unisoc's, but the production ball-map is still a
controlled document). What changed is that the e1-phone no longer *needs* the
NDA to be buildable: there is now a complete, purchasable-from-public-data
compute path via the SoM. The bare-SoC + NDA route is retained as a documented
cost-down option, not a blocker.

**Bare-SoC cost-down path (optional, later):**
  1. Contact the chosen SoC vendor (Rockchip via authorized distributor for
     RK3566, or Unisoc via Arrow/WPG/Tier-1 ODM for T606/T616).
  2. Sign the vendor NDA + Design-In Agreement and request the SoC Hardware
     Design Guide (full BGA ball-map + reference schematic + PCB stack-up + BSP).
  3. Mirror the ball-map CSV to
     `board/kicad/e1-phone/production/sourcing/soc/pinout-or-pad-map.csv` and
     emit `<vendor>-<soc>-pinout.yaml` with
     `evidence_class: nda_supplier_datasheet`.
  4. Flip the SoC row in `pinout-footprint-freeze.yaml` to the bare-SoC variant
     and re-run the pinout-review gate.

Until that optional step closes, the SoM remains the canonical buildable-now
compute source and there are **no** NDA-gated lines blocking a public-data build.

## Evidence-class convention

- `public_supplier_datasheet` — pinout sourced from a public web page or
  publicly downloadable PDF; what this directory captures.
- `public_som_connector_pinout` — board-to-board / edge-connector signal map of
  a turnkey System-on-Module, published in a public vendor datasheet (the
  compute path; see `compute-som-pinout.yaml`).
- `nda_supplier_datasheet` — pinout sourced from a document released under
  NDA (Unisoc RDK, Quectel Partner Portal HW Design, OmniVision sensor reg
  spec, etc.). These overwrite the public capture once procurement closes.
- `production_release_evidence` — toolmaker FAI signoff + sample inspection;
  required for production release but **separate gate** from this directory.

## Cross-references

- `../preliminary-bom.yaml` — driving BoM
- `../pinout-footprint-freeze.yaml` — gate this evidence feeds
- `../supplier-to-kicad-evidence-map.yaml` — RFQ-to-KiCad mapping per function
- `../supplier-rfq-intake.yaml` — RFQ status per function
- `pinout-evidence-manifest.yaml` — machine-readable index of this directory
