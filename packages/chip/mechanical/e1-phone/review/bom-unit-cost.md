# e1-phone — Production Unit Cost (10k / 100k volumes)

**Date:** 2026-05-21
**Status:** Sourcing-analyst estimate; NOT a release BOM, NOT a signed quote.
**Evidence class:** public_sourcing_estimate.
**Design rev:** evt0-mechanical-cad-swell-camera-seal (12.7 mm flush back, 5.6 mm / 5727 mAh battery with 0.6 mm swell void, rear torch/flash LED, QPC1252Q aperture tuner, PORON glass cushion, 10 screw bosses + corner ribs, RK3566 compute SoM).
**Currency:** USD, EXW Shenzhen.
**Companion data:** [`bom-unit-cost.yaml`](./bom-unit-cost.yaml), [`compute-sourcing-resolution.md`](./compute-sourcing-resolution.md).

## Compute sourcing (NDA blocker retired)

Compute (line 1) is sourced as a turnkey **RK3566 System-on-Module**
(Firefly **Core-3566JD4** class, **PATH A**) that bundles SoC + LPDDR4 +
eMMC + PMIC behind a **public 260-pin SODIMM connector pinout**
([`compute-som-pinout.yaml`](../../../board/kicad/e1-phone/supplier-pinouts/compute-som-pinout.yaml)).
This retires the only NDA-gated procurement line on the BoM — the phone is
buildable today from public data. The bare-SoC route (Unisoc T606 / RK3566 +
discrete LPDDR4 + eMMC + PMIC, **PATH B**) is retained as a documented
cost-down-at-scale option but needs the SoC vendor NDA for the BGA ball-map.
The SoM (default) costs **+$7.10/unit @10k** and **+$4.55/unit @100k** over
the bare-SoC bundle. RAM/eMMC/PMIC lines (2/3/4) are folded into the SoM and
zeroed below to avoid double-counting.

## Summary

At an order volume of 10,000 units the e1-phone (5.5" FHD, RK3566 SoM,
2 GB / 32 GB, 5G RedCap, 5727 mAh) lands at an **ex-factory cost of
≈ $123.90 per unit** (PATH A SoM), dominated by the Quectel RG255C 5G RedCap
modem ($22.50), the compute SoM ($32.00), and the LCD module ($14.50).
Amortizing the ~$60k injection-mold NRE plus ~$6k PCBA NRE over 100,000 units
and applying the volume-tier prices reachable for the SoM/modem/Wi-Fi/display/
camera/battery lines, the ex-factory cost falls to **≈ $93.03 per unit**.
Under the bare-SoC PATH B (NDA cost-down) the same build is **≈ $116.80 @10k /
≈ $88.48 @100k**.
The flush-back rev added ≈ $0.58-0.64 / unit vs the prior 9.6 mm design (larger
battery, rear torch/flash LED, flash driver IC). The subsequent swell/camera/seal
+ Wave-2 rev adds a further **≈ $0.46 / unit @10k, ≈ $0.34 / unit @100k**: a
Qorvo QPC1252Q antenna aperture tuner (≈ +$0.30-0.40, the low-band cellular fix),
a PORON glass-perimeter cushion (≈ +$0.02-0.03, the face-drop fix), and +4 M1.4
screws for the 6→10 boss count (≈ +$0.02-0.03, the corner-drop fix); the corner
ribs/gussets are molded-in at no extra fastener cost. The single-lens rear and
single-lens front cameras are unchanged (no array), so camera lines hold.
A 3× retail markup yields the typical range **$279 (100k) to $372 (10k)**,
which is consistent with positioning this device against entry-level
Redmi/Realme RedCap handsets in the China-domestic and emerging-market
segments. The single largest cost-reduction lever (≈ -$12 / unit) is
replacing 5G RedCap with an LTE-Cat4 modem; the second is moving from
Murata Wi-Fi 6E to a Realtek Wi-Fi 6 module (≈ -$2.50 / unit).

## Confidence Statement

Five lines carry **high** confidence (PD controller, charger IC, audio codec,
USB-C, tactile switches, MEMS mics — all sourced from current LCSC product
pages with explicit per-unit pricing). Medium-confidence lines include the
compute SoM, modem, Wi-Fi, display, rear camera, battery, and PCB
fab — where Alibaba/distributor pricing exists but exact 10k-tier
contract pricing is reasoned from public trade-press, distributor singles,
and known volume curves. The remaining lines are formal **estimates** with
a cited analog (Alibaba showroom listings, generic Shenzhen ODM cost
structures, published injection-mold guides). The high+medium lines cover
roughly 78% of total BOM dollars, so even if every estimate line is off by
±25%, total ex-factory cost is bounded within ±$3-4 per unit.

## Line Table

| # | Function | Qty | MPN / Class | $/unit @10k | $/unit @100k | Conf |
|---|----------|----:|-------------|-----------:|------------:|:---:|
| 1 | Compute SoM (SoC+LPDDR4+eMMC+PMIC) | 1 | Firefly Core-3566JD4 RK3566, 2 GB/32 GB (PATH A) | 32.00 | 26.00 | med |
| 2 | RAM LPDDR4 | — | folded into SoM (PATH A); bare alt SK Hynix 4 GB = 9.50/8.40 | 0.00 | 0.00 | med |
| 3 | eMMC | — | folded into SoM (PATH A); bare alt Kioxia 64 GB = 5.40/4.60 | 0.00 | 0.00 | med |
| 4 | PMIC | — | folded into SoM (PATH A); bare alt SC2730 = 1.80/1.45 | 0.00 | 0.00 | low |
| 1B | (PATH B alt) bare Unisoc T606/RK3566 + discrete RAM/eMMC/PMIC | 1 | needs SoC vendor NDA | 24.90 | 21.45 | med |
| 5 | USB PD controller | 1 | TI TPS65987DDHRSHR | 1.55 | 1.30 | high |
| 6 | Charger IC | 1 | TI BQ25895RTWR | 0.95 | 0.78 | high |
| 7 | Audio codec | 1 | Realtek ALC5640 | 1.05 | 0.85 | high |
| 8 | Haptic driver | 1 | SGM31320-class | 0.85 | 0.65 | est |
| 9 | Wi-Fi/BT module | 1 | Murata Type 2EA (LBEE5XV2EA-802) | 5.80 | 4.90 | med |
| 10 | Cellular modem | 1 | Quectel RG255C 5G RedCap | 22.50 | 18.50 | med |
| 11 | SIM tray | 1 | Nano-SIM tray + socket | 0.28 | 0.18 | est |
| 12 | 5.5" FHD LCD + CTP | 1 | Chenghao CH550FH01A-CT | 14.50 | 11.80 | med |
| 13 | Cover glass 2.5D 0.7 mm | 1 | Lens/Biel chemically-strengthened | 1.60 | 1.20 | est |
| 13a | Glass perimeter cushion (face-drop fix) | 1 | die-cut PORON 4701-class PU foam | 0.03 | 0.02 | est |
| 14 | Display adhesive frame | 1 | Tesa/3M die-cut | 0.12 | 0.08 | est |
| 15 | Rear camera 13 MP OV13855 (single lens) | 1 | Sincere First / Sunny Optical | 4.80 | 3.90 | med |
| 15a | Rear torch/flash LED ~1.0x1.0 mm | 1 | Everlight / OSRAM-class white flash LED | 0.08 | 0.06 | est |
| 15b | Flash driver IC | 1 | Awinic AW36515FCR (SGM3140 alt) | 0.16 | 0.12 | est |
| 15c | Antenna aperture tuner (low-band fix) | 1 | Qorvo QPC1252Q (pSemi PE613050 alt), MIPI RFFE | 0.40 | 0.30 | est |
| 16 | Front camera 5 MP GC5035 (single lens) | 1 | Sincere First / O-Film | 1.40 | 1.10 | med |
| 17 | USB-C receptacle | 1 | GCT USB4105-GF-A | 0.42 | 0.31 | high |
| 18 | Tactile switches (side) | 3 | Panasonic EVQP7A01P | 0.18 | 0.13 | high |
| 19 | MEMS mics | 2 | Knowles SPK0641HT4H-1 | 0.95 | 0.74 | high |
| 20 | Earpiece receiver 1206 | 1 | AAC / Goertek | 0.45 | 0.32 | est |
| 21 | Speaker module 1115 + chamber | 1 | AAC / Goertek 1115 box | 0.95 | 0.70 | est |
| 22 | LRA 0612 X-axis | 1 | Leader Microelectronics LRA0612X | 1.60 | 1.20 | est |
| 23 | Battery LiPo 5727 mAh + PCM | 1 | LiPol LP566487-class 5.6 mm (incl. PCM, NTC, JST) | 4.20 | 3.35 | med |
| 24 | Battery PCM | — | bundled in line 23 | 0.00 | 0.00 | high |
| 25 | Battery FPC/harness | — | bundled in line 23 | 0.00 | 0.00 | high |
| 26 | NFC | 0 | excluded per spec | 0.00 | 0.00 | high |
| 27 | PCB fab 6L HDI ~85 cm² | 1 | Shennan / WUS / Suntak | 3.20 | 2.40 | med |
| 28 | PCBA SMT per unit | 1 | Wingtech / Huaqin / Longcheer | 3.50 | 2.10 | med |
| 28b | PCBA NRE (amortized) | — | stencil + AOI + ICT fixture | 0.60 | 0.06 | est |
| 29 | Enclosure plastic (PC+ABS) | 1 | Kingfa colored PC/ABS | 0.18 | 0.13 | est |
| 30 | Injection-mold tooling (amortized) | — | hard-tool 2-cavity steel | 6.00 | 0.60 | med |
| 30b | Molding cycle per unit | 1 | machine-time + colorant | 0.35 | 0.22 | est |
| 31 | Screws + standoffs (6→10 bosses) | 10 | M1.4 SS + brass inserts | 0.15 | 0.10 | est |
| 32 | Antennas (cellular x2 + Wi-Fi) | 3 | FPC laser-cut copper-on-PI | 1.60 | 1.10 | est |
| 33 | FPCs internal interconnect | 5 | display + 2x camera + USB-C + sidekey + T-B | 2.60 | 1.85 | est |
| 34 | EMI shields/cans | 6 | C7521 stamped shield + frame set | 0.85 | 0.55 | est |
| 35 | Gaskets/adhesives/foam | kit | 3M / Nitto / Poron die-cut | 0.55 | 0.38 | est |
| 36 | Packaging (box + manual + USB-C cable, no charger) | 1 | custom retail box + ByteCable 1 m | 1.85 | 1.30 | est |
| 37 | Labor + test + 6% scrap | 1 | factory-loaded | 4.80 | 3.20 | est |
| 38 | Inbound logistics + duty | 1 | freight + broker | 0.85 | 0.55 | est |

## Rollup

| Sub-total | @10k | @100k |
|-----------|-----:|------:|
| Components (lines 1-26, 31-35; line 1 = SoM PATH A, lines 2/3/4 folded in) | $105.65 | $84.79 |
| PCB fab + PCBA + NRE | $7.30 | $4.56 |
| Enclosure (plastic + tooling amortized + mold cycle) | $6.53 | $0.95 |
| Packaging | $1.85 | $1.30 |
| Labor / test / yield | $4.80 | $3.20 |
| Inbound logistics | $0.85 | $0.55 |
| **Ex-factory unit cost (PATH A — SoM, buildable from public data)** | **$123.90** | **$93.03** |
| Ex-factory unit cost (PATH B — bare SoC, NDA cost-down) | $116.80 | $88.48 |
| SoM premium vs bare-SoC | +$7.10 | +$4.55 |
| Retail @ 2× markup (PATH A) | $247.80 | $186.06 |
| Retail @ 3× markup (PATH A) | $371.70 | $279.09 |

Flush-back-rev delta vs prior 9.6 mm design: **+$0.64/unit @10k**, **+$0.58/unit @100k**
(bigger battery +$0.40, flash driver +$0.16/+$0.12, torch LED +$0.08/+$0.06).

Swell/camera/seal + Wave-2-rev delta vs flush-back rollup: **+$0.46/unit @10k**,
**+$0.34/unit @100k** (QPC1252Q aperture tuner +$0.40/+$0.30, PORON glass-perimeter
cushion +$0.03/+$0.02, +4 M1.4 screws +$0.03/+$0.02). Corner ribs/gussets are
molded-in (no fastener cost; plastic in line 29, mass in the mass budget).

NRE totals: injection-mold tooling **$60,000**, PCBA NRE **$6,000**, total
**$66,000** one-time.

## Source URLs cited (≥15 distinct)

1. https://en.t-firefly.com/product/core/core3566jd4.html  (Core-3566JD4 RK3566 SoM, PATH A compute)
1b. https://download.t-firefly.com/Spec/CoreBorads/Core-3566JD4_Specification_EN.pdf  (public 260-pin SODIMM pinout)
1c. https://www.alibaba.com/product-detail/RK3566-SOM-Core-Board-with-Android_1601173331751.html  (RK3566 SoM volume listing)
1d. https://www.lcsc.com/product-detail/C2943786.html  (bare RK3566 SoC, PATH B)
1e. https://www.unisoc.com/en_us/home/TZNSJ-T606-5-2  (bare Unisoc T606, PATH B)
2. https://www.alibaba.com/product-detail/Unisoc-T606-Phones-Mobile-Android-Smartphone_1600688616501.html
3. https://product.skhynix.com/products/dram/lpddr/lpddr4x_4.go
4. https://www.trendforce.com/news/2025/07/11/news-sk-hynix-reportedly-raises-ddr4-lpddr4x-contract-prices-by-20-as-q3-demand-stays-strong/
5. https://www.lcsc.com/product-detail/eMMC_KIOXIA_C2895986.html
6. https://www.lcsc.com/product-detail/C2868843.html  (TPS65987DDH)
7. https://www.lcsc.com/product-detail/C80200.html  (BQ25895)
8. https://www.lcsc.com/product-detail/Codec-ICs_Realtek-Semicon-ALC5640-VB-CG_C472491.html
9. https://www.murata.com/products/connectivitymodule/wi-fi-bluetooth/overview/lineup/type2ea
10. https://www.digikey.com/en/products/detail/murata-electronics/LBEE5XV2EA-802/22205340
11. https://www.quectel.com/product/5g-redcap-rg255c-series/
12. https://www.cnx-software.com/2026/03/03/quectel-rm255c-mid-tier-5g-redcap-m-2-and-lga-modules-support-lte-cat-4-fallback-multi-constellation-gnss/
13. https://www.chenghaolcd.com/doc/26717023/5-5-inch-ltps-tft-lcd-module-1080-1920-resolution-mipi-lcd-screen.pdf
14. https://laserlcd.en.made-in-china.com/product/enjpqMfOhaRI/China-5-5-Inch-CTP-1080-1920-Mipi-Interface-LCD-Display-FHD-LCD-Screen-for-Industrial-Display.html
15. https://www.alibaba.com/product-detail/Factory_Price_OV13850_OV13855_OV13858_MIPI_CSI_Camera_module_cmos_Omnivision_Sensor_13mp_camera_module_60722404002.html
16. https://www.globalsources.com/product/ov13850-ov13858-ov13855-13mp-camera-module_1180373429f.htm
17. https://www.alibaba.com/product-detail/Mini-Camera-Module-5MP-GC5035-CMOS_1600446425146.html
18. https://www.lcsc.com/product-detail/usb-connectors_global-connector-technology-usb4105-gf-a_C3020560.html
19. https://www.lcsc.com/product-detail/Tactile-Switches_PANASONIC-EVQP7A01P_C79167.html
20. https://www.lcsc.com/product-detail/mems-microphones_knowles-spk0641ht4h-1_C5159510.html
21. https://www.lipobattery.us/lihv-lipo-battery-3-85v-lp446487-4500mah-17-33wh-with-pcm-and-ntc-and-jst-shr-03v-s-b/
22. https://www.pcbelec.com/blog/pcb-cost-and-budgeting/what-factors-determine-the-price-of-pcb.html
23. https://www.mktpcb.com/pcb-manufacturing/hdi-pcb/
24. https://www.7pcb.com/blog/surface-mount-smt-assembly-cost-china
25. https://www.chinapcbassembly.com/blog/how-much-does-pcb-assembly-cost-a-detailed-cost-breakdown
26. https://www.cs-dv.com/news/china-plastic-injection-mold.html
27. https://boyanmfg.com/injection-mold-cost-in-china/
28. https://haitongele.com/fpc-antenna/
29. https://haitongele.com/lds-antenna/
30. https://www.alibaba.com/showroom/stamped-precision-emi-shielding.html
31. https://www.bytecable.com/usb-c-cable-factory/
32. https://www.majorcustompackaging.com/product/cable-retail-box/
33. https://www.lcsc.com/product-detail/LED-Drivers_AWINIC-Shanghai-Awinic-Tech-AW36515FCR_C2844183.html  (AW36515 flash driver)
34. https://www.sg-micro.com/product/SGM3140  (SGM3140 flash driver alt)
35. https://en.everlight.com/visible_led/category-flash_led/  (Everlight flash LED)
36. https://li-polymer-battery.com/high-energy-density-option-li-polymer-battery-3-85v-5800mah-lphv486697/  (5800 mAh 3.85 V pouch)
37. https://www.qorvo.com/products/p/QPC1252Q  (Qorvo QPC1252Q aperture/band-switch tuner, line 15c)
38. https://psemi.com/products/rf-switches/antenna-tuning-switches/pe613050/  (pSemi PE613050 tuning-control switch, tuner alt)
39. https://www.rogerscorp.com/elastomeric-material-solutions/poron-industrial-polyurethanes  (PORON glass-perimeter cushion, line 13a)

## Top cost-down levers (ranked)

1. **5G RedCap → LTE Cat4 modem** — ≈ **-$12.00 / unit**. Drops the 5G headline feature; entry-Asian / Africa / LATAM positioning still works.
2. **Mold NRE amortization at 100k vs 10k** — ≈ **-$5.40 / unit**. Pure working-capital / demand-volume play.
3. **Murata Wi-Fi 6E → Realtek Wi-Fi 6 (RTL8852BS)** — ≈ **-$2.50 / unit**. Drops 6 GHz band.
4. **Kioxia eMMC → Longsys / Foresee / YMTC eMMC** — ≈ **-$0.60 / unit**. China-only supply, requires re-qual.
5. **Knowles → Goertek MEMS mics** — ≈ **-$0.50 / unit** (2 mics).

Cumulative aggressive cost-down at 100k volume could push ex-factory unit
cost below ≈ **$67** if every lever is pulled, opening a sub-$200 retail
price point at 3× markup.

## Required follow-ups before release BOM

- Signed RK3566 SoM vendor RFQ (Firefly Core-3566JD4 or equivalent) at 10k and 100k, with the public 260-pin SODIMM pinout confirmed against the shipped board revision (PATH A, default).
- (PATH B cost-down only) Unisoc T606 / RK3566 bare-SoC RFQ + NDA/design-in at 10k and 100k.
- Quectel RG255C-GL region-SKU RFQ.
- Murata authorized-distributor 10k quote vs. Realtek RTL8852BS Chinese channel quote.
- Display module supplier RFQ (Chenghao or BOE) with init sequence + FPC drawing.
- LiPol / Grepow 5727 mAh (LP566487-class, 5.6 mm) battery pack quote with safety-doc package.
- Awinic AW36515 (or SGM3140) flash driver + flash LED quote at 10k/100k.
- Qorvo QPC1252Q (or pSemi/Murata PE613050) RFFE aperture-tuner RFQ + availability at 10k/100k (no public unit price; estimate-tier line).
- Tool-shop quote for hard-tool front + rear + small-parts mold set.
- ODM EMS (Wingtech / Huaqin / Longcheer) loaded PCBA + assembly + test quote at both volumes.
