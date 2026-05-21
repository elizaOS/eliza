# e1-phone supplier pinouts (public-datasheet evidence)

This directory captures the **public supplier pinouts** for every e1-phone
board component named in `preliminary-bom.yaml` / `pinout-footprint-freeze.yaml`.
Files here are tagged `evidence_class: public_supplier_datasheet` — they are
**not** production-release evidence. Production release additionally requires
the toolmaker / FAI signoff captured under
`board/kicad/e1-phone/production/reports/pinout-review/<function>.yaml` per
`supplier-to-kicad-evidence-map.yaml`.

## Captured pinouts (10)

| # | File | Part | Manufacturer | Status |
|---|------|------|--------------|--------|
| 1 | `gct-usb4105-pinout.yaml` | USB4105-GF-A USB-C 2.0 receptacle, 24 positions | GCT | full pin table (USB-IF Type-C standard) |
| 2 | `quectel-rg255c-pinout.yaml` | RG255C-EAB 5G RedCap LGA | Quectel | interfaces verified; per-pad table behind Quectel Partner Portal |
| 3 | `murata-type-2ea-pinout.yaml` | LBEE5XV2EA-802 Wi-Fi 6E + BT 5.3 (Type 2EA) | Murata | interface pin groups verified; per-pad coords in binary datasheet PDF |
| 4 | `panasonic-evq-p7-pinout.yaml` | EVQ-P7A01P side-push SMT tactile switch | Panasonic | full mechanical/electrical, 4-terminal layout |
| 5 | `ov13855-pinout.yaml` | OV13855 13MP rear MIPI camera module (Sincere First SF-XR3855A class) | OmniVision / Sincere First | canonical 24-pin signal set; per-pin FPC order via signed drawing |
| 6 | `gc5035-pinout.yaml` | GC5035 5MP front MIPI camera module (Sincere First SF-G5035S60FY class) | GalaxyCore / Sincere First | canonical 22-pin signal set; per-pin FPC order via signed drawing |
| 7 | `chenghao-ch550fh01a-pinout.yaml` | CH550FH01A-CT 5.5" FHD MIPI DSI + PCAP display module | Shenzhen Chenghao | canonical 40-pin signal set; per-pin FPC order via signed spec |
| 8 | `hirose-bm28-pinout.yaml` | DF40C-80DP-0.4V(51) 80-pos 0.4 mm B2B (BM28 family equivalent) | Hirose | full mechanical, dual-row A1-A40 / B1-B40, signal assignment carried by flex |
| 9 | `tps65987-pinout.yaml` | TPS65987DDH USB-PD 3.1 controller, 96-pin QFN | Texas Instruments | interface groups verified; per-pin QFN table via TI datasheet PDF / .bsdl |
| 10 | `max77860-pinout.yaml` | MAX77860EWG+ USB-C buck charger, 81-bump WLP | Analog Devices (Maxim) | interface groups verified; per-bump table via ADI datasheet PDF |

For files where `pins: [{pin: ALL, name: fetch_required, ...}]`, the **public
vendor page confirms the package, pin count, and interface groups**, but the
**per-pin coordinate table** is in a binary PDF figure or behind a partner
portal and must be re-emitted with full per-pin entries before the
corresponding `pinout-review/<function>.yaml` signoff can flip to ready.

## Remaining NDA-gated pinouts (1)

The only component on the e1-phone BoM whose pinout is **genuinely
NDA-gated** (cannot be retrieved by any public-web search) is the application
processor SoC:

### Unisoc T606 / T616 (UMS9230)

- **Package:** BGA, ~600 balls.
- **Status:** `nda_gated_pinout_unblock_path_documented`
- **Why blocked:** Unisoc does not publish AP SoC pinouts on its public web
  site. The pad map ships only inside the Reference Design Kit (RDK) that
  Unisoc releases to design-in customers after NDA execution.
- **Unblock procedure:**
  1. Contact Unisoc via an **authorized regional distributor** (e.g. Arrow,
     WPG/WT, or a Unisoc-named Tier-1 ODM in PRC). Walk-in requests to
     unisoc.com/contact are routed to the same distributor channel.
  2. Sign Unisoc's **Mutual NDA** plus the **Design-In Agreement** for the
     T606 / T616 platform. Both are required before any document release.
  3. Request the **T606 (or T616) Reference Design Kit**, which contains:
     - SoC Hardware Design Guide (with full BGA ball map and ball-attribute
       tables)
     - Reference Schematic (pre-routed PMIC + DDR + audio + RF)
     - Reference PCB stack-up
     - Linux/Android BSP and bring-up image
  4. Mirror the ball-map CSV to
     `board/kicad/e1-phone/production/sourcing/soc/pinout-or-pad-map.csv`
     and emit `unisoc-t606-pinout.yaml` in this directory with
     `evidence_class: nda_supplier_datasheet`.
  5. Flip the SoC row in `pinout-footprint-freeze.yaml` from blocked to
     captured and re-run the pinout-review gate.

Until step 4 completes, the SoC remains the **only** un-unblockable line item
in the supplier-evidence chain.

## Evidence-class convention

- `public_supplier_datasheet` — pinout sourced from a public web page or
  publicly downloadable PDF; what this directory captures.
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
