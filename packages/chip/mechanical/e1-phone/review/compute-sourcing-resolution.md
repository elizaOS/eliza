# e1-phone — Compute Sourcing Resolution (NDA blocker retired)

**Date:** 2026-05-21
**Evidence class:** public_som_connector_pinout + public_sourcing_estimate
**Status:** Decision record. Retires the e1-phone's last hard procurement blocker.
**Companions:**
[`compute-som-pinout.yaml`](../../../board/kicad/e1-phone/supplier-pinouts/compute-som-pinout.yaml),
[`supplier-pinouts/README.md`](../../../board/kicad/e1-phone/supplier-pinouts/README.md),
[`supplier-pinouts/pinout-evidence-manifest.yaml`](../../../board/kicad/e1-phone/supplier-pinouts/pinout-evidence-manifest.yaml),
[`bom-unit-cost.yaml`](./bom-unit-cost.yaml).

## The blocker

The e1-phone's only genuinely NDA-gated line was the compute application
processor. The original BoM specced a **bare Unisoc T606 (UMS9230) BGA**, whose
~600-ball pad map ships only inside Unisoc's Reference Design Kit, released after
a Mutual NDA + Design-In Agreement. A bare AP BGA *always* carries an NDA — that
is intrinsic to buying a raw application processor — so the board could not be
laid out, fabbed, or assembled from public data alone.

## The fix: source the AP role as a turnkey SoM with a public connector pinout

The standard way to make a phone buildable from public data is to buy a turnkey
**System-on-Module** (SoC + LPDDR + eMMC + PMIC integrated) that exposes a
**documented board-to-board / edge connector** instead of a bare BGA. The
carrier board then only has to route the connector — not the SoC's secret ball
map.

**Chosen module:** **Firefly Core-3566JD4** (Rockchip RK3566 SoM).

| Attribute | Value |
|-----------|-------|
| MPN / vendor | Core-3566JD4 / Firefly (T-chip Intelligent Technology, Shenzhen) |
| SoC | Rockchip RK3566, quad Cortex-A55 @ up to 1.8 GHz, Mali-G52 2EE, 1 TOPS NPU |
| On-module | LPDDR4 1-8 GB + eMMC 8-128 GB + PMIC (RK809/RK817 class) |
| Carrier connector | **260-pin gold-finger SODIMM, 0.5 mm pitch — full per-pin signal table published in the public datasheet** |
| Public pinout doc | https://download.t-firefly.com/Spec/CoreBorads/Core-3566JD4_Specification_EN.pdf |
| Product page | https://en.t-firefly.com/product/core/core3566jd4.html |
| Wiki / schematics / BSP | https://wiki.t-firefly.com/en/Core-3566JD4/ |
| SoC public docs | Rockchip RK3566 datasheet + Hardware Design Guide (public; community-mirrored) |
| BSP | Android 11 / Ubuntu / Debian / Buildroot+Qt (Rockchip RK356x SDK, public) |
| Price | ~$49 single-qty (2 GB/32 GB) at IndustryPC / Firefly Store; generic RK3566 SoMs $28-35 small-vol, ~$24-28 at 1k+ OEM on Alibaba |

### Why this module clears every e1-phone AP-role interface

The public 260-pin SODIMM map (captured pin-by-pin in `compute-som-pinout.yaml`)
exposes everything the e1-phone needs:

- **Display:** MIPI-DSI TX0 (4 data + clk diff pairs) + panel reset / power /
  backlight / touch-int → drives the 5.5" FHD panel. (A second DSI link, DSI1,
  is also exposed.)
- **Cameras:** 4-lane MIPI-CSI RX (2 clk lanes + 4 data lanes) + MCLK0/MCLK1 +
  per-camera reset/power-down → rear 13 MP + front 5 MP.
- **Modem:** USB2.0 HOST (pins 9/11, 15/17) and USB2.0 OTG → the Quectel RG255C
  5G RedCap module (separate, public pinout) attaches over USB. USB3.0 SS pair
  is also available (muxed with SATA1).
- **Wi-Fi/BT:** SDMMC1 (SDIO) + WIFI_REG_ON / BT_REG_ON / wake / 32 kHz →
  the Murata Type-2EA module. A PCIe 2.1 lane is available as an alternate.
- **Power:** single 5 V input (VCC5V0_SYS); the on-module PMIC generates internal
  rails and returns 3.3 V / 1.8 V on the connector.
- **Boot/control:** RECOVERY (pin 152), SYS_RESET (pin 218), I2C / UART / SPI /
  ADC / GPIO.

## Two paths, honestly stated

### PATH A — SoM, buildable from public data (default)

Buy the Core-3566JD4-class SoM. Connector pinout is public, BSP is public,
module is buyable at MOQ 1. **No NDA anywhere in the compute path.** This is the
path the current BoM and unit-cost rollup use.

### PATH B — bare SoC, cost-down at scale (optional, later)

At high volume, dropping the SoM and placing a **bare SoC** (Unisoc T606 or bare
RK3566) plus discrete LPDDR4 + eMMC + PMIC on the e1-phone PCB is cheaper per
unit. It still requires the SoC vendor's NDA'd Hardware Design Guide for the
production BGA ball-map, plus in-house DDR/eMMC layout and signal-integrity
bring-up. Rockchip's RK3566 documentation is far more openly mirrored than
Unisoc's, so RK3566 is the lower-friction bare-SoC target — but the production
ball-map is still a controlled document.

### Cost delta (from `bom-unit-cost.yaml`)

| | @10k | @100k |
|---|-----:|------:|
| PATH A compute SoM (bundles SoC+RAM+eMMC+PMIC) | $32.00 | $26.00 |
| PATH B bare SoC + discrete RAM+eMMC+PMIC | $24.90 | $21.45 |
| **SoM premium** | **+$7.10** | **+$4.55** |
| Ex-factory unit cost — PATH A | $123.44 | $92.69 |
| Ex-factory unit cost — PATH B | $116.34 | $88.14 |

The SoM premium also folds in the board-to-board connector and removes the
SoC/DDR/eMMC routing + DDR signal-integrity NRE the bare-SoC path would incur,
so the effective premium is smaller than the line delta suggests at low volume.

## Performance honesty

The RK3566 (4× Cortex-A55) is **weaker** than the T606 (2× Cortex-A75 + 6×
Cortex-A55) in multithreaded workloads — public benchmarks (cpubenchmark.net,
gadgetversus) put the T606 ahead. This is acceptable for the e1-phone AP role:
the modem is an external Quectel module (not on the AP), the display is 5.5" FHD,
and the RK3566 carries a 1 TOPS NPU and full MIPI-DSI/CSI + Android BSP. If
peak CPU throughput becomes a requirement, the same SoM family scales up
(RK3568 / RK3576 SoMs share the SODIMM form factor and publish the same class of
public pinout), or PATH B can adopt the higher-performing T606 once the NDA
closes.

## Verdict

**Compute is now purchasable from public data.** The e1-phone is buildable today
via the Firefly Core-3566JD4 RK3566 SoM, whose 260-pin SODIMM connector pinout
is published without NDA and captured in `compute-som-pinout.yaml`. The
supplier-evidence manifest now reports **zero NDA-gated lines**. The bare-SoC +
NDA route (Unisoc T606 or bare RK3566) is retained as a documented
cost-down-at-scale option — not a blocker. The bare-T606 NDA itself has not
disappeared; what is gone is the *dependency* on it to build the phone.
