# Release Intake + BOM Cost Agent Report - 2026-05-28

Status: blocked external release evidence missing.

Claim boundary: this is a research and local inventory report only. It does not create supplier, factory, lab, physical first-article, fabrication, enclosure, or end-to-end release evidence.

## Local Intake State

The repo has substantial local scaffolding, but all release gates still fail closed:

- Routed board acceptance: `blocked_fail_closed_routed_board_release_acceptance_not_met`
- Routed required output paths: 46
- Routed candidate-present but blocked paths: 37
- Factory candidate manifest: 46 local candidate artifacts, `release_credit: false`
- Release evidence dry run: 212 validation rows, 0 externally validated, 212 blocked
- Supplier return matrix: 13 lanes, 221 required supplier evidence rows, all fail closed
- Objective audit: `blocked_objective_not_complete`

Important intake paths:

- `board/kicad/e1-phone/production/readiness/routed-board-release-acceptance-matrix-2026-05-22.yaml`
- `board/kicad/e1-phone/production/readiness/release-evidence-content-contract-2026-05-22.yaml`
- `board/kicad/e1-phone/production/readiness/release-evidence-validation-dry-run-2026-05-22.yaml`
- `board/kicad/e1-phone/production/sourcing/readiness/supplier-return-evidence-acceptance-matrix-2026-05-22.yaml`
- `board/kicad/e1-phone/production/factory-output-candidate-manifest-2026-05-22.yaml`
- `board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml`

## Missing Release Artifacts

These are required and still not release-valid:

| Artifact class | Exact repo path | Current state | Can generate local candidate? | Release credit |
| --- | --- | --- | --- | --- |
| Schematic ERC | `board/kicad/e1-phone/production/reports/erc.json` | missing release evidence | yes | no |
| PCB DRC | `board/kicad/e1-phone/production/reports/drc.json` | missing release evidence | yes | no |
| Routed KiCad PCB | `board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb` | local candidate only | yes | no |
| Gerbers / drill / IPC-2581 / POS | `board/kicad/e1-phone/production/gerbers`, `production/ipc-2581`, `production/pos` | local candidates only | yes | no |
| Production BOM/AVL | `board/kicad/e1-phone/production/bom` | local candidate only | yes | no |
| Stackup/impedance/coupon | `board/kicad/e1-phone/production/stackup` | fabricator approval missing | no, external required | no |
| Supplier component models | `board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml` | unvalidated | partial surrogate only | no |
| Routed STEP clearance | `mechanical/e1-phone/review/routed-board-clearance.json` | release clearance missing | candidate possible | no |
| SI/PI/RF/power thermal | `board/kicad/e1-phone/production/reports/si-pi`, `production/reports/rf`, `production/reports/power-thermal` | lab/simulation evidence missing | candidate possible | no |
| Factory limits and first article | `board/kicad/e1-phone/production/test/factory-test-limits.yaml`, `production/first-article` | physical/factory evidence missing | templates only | no |
| Fab/assembly/fixture/enclosure-DFA quotes | `board/kicad/e1-phone/production/fab-quote`, `production/dfm`, `production/test/fixture-quote`, `production/reports/enclosure-dfa` | external commercial response missing | no | no |

## Supplier Lanes

Every public listing or placeholder remains insufficient unless it is returned as a signed response pack with MPN, quote, drawing, pinout/pad map, land pattern, STEP/B-rep, sample lot, compliance data, and approvals.

| Function | Selected hardware | Intake template | Return archive |
| --- | --- | --- | --- |
| Display/touch | `CH550FH01A-CT` | `board/kicad/e1-phone/production/sourcing/display_touch/rfq-response-pack-intake-template.yaml` | `board/kicad/e1-phone/production/sourcing/display_touch/rfq-response-pack.yaml` |
| Rear camera | `SF-XR3855A-A0_OV13855_or_OV13850_13MP_AF` | `production/sourcing/rear_camera/rfq-response-pack-intake-template.yaml` | `production/sourcing/rear_camera/rfq-response-pack.yaml` |
| Front camera | `SF-G5035S60FY_GC5035_5MP_FF_MIPI` | `production/sourcing/front_camera/rfq-response-pack-intake-template.yaml` | `production/sourcing/front_camera/rfq-response-pack.yaml` |
| Cellular | `Quectel_RG255C_or_RM255C_5G_RedCap` | `production/sourcing/cellular/rfq-response-pack-intake-template.yaml` | `production/sourcing/cellular/rfq-response-pack.yaml` |
| Wi-Fi/BT | `Murata_LBEE5XV2EA-802_Type_2EA` | `production/sourcing/wifi_bluetooth/rfq-response-pack-intake-template.yaml` | `production/sourcing/wifi_bluetooth/rfq-response-pack.yaml` |
| USB-C | `GCT_USB4105_class_USB2_Type_C` | `production/sourcing/usb_c_receptacle_evt0/rfq-response-pack-intake-template.yaml` | `production/sourcing/usb_c_receptacle_evt0/rfq-response-pack.yaml` |
| USB-PD | `TI_TPS65987DDH` | `production/sourcing/charger_pd/rfq-response-pack-intake-template.yaml` | `production/sourcing/usb_pd_controller/rfq-response-pack.yaml` |
| Charger path | `MAX77860_class` | `production/sourcing/charger_pd/rfq-response-pack-intake-template.yaml` | `production/sourcing/charger_power_path/rfq-response-pack.yaml` |
| Side buttons | `Panasonic_EVQ-P7_EVQ-P3_EVQ-9P7_side_push_tactile` | `production/sourcing/side_buttons/rfq-response-pack-intake-template.yaml` | `production/sourcing/side_buttons/rfq-response-pack.yaml` |
| Battery pack | `LiPol_LP566487_3p85V_5727mAh_22p05Wh_PCM_NTC_JST_SHR_03V_class` | `production/sourcing/battery/rfq-response-pack-intake-template.yaml` | `production/sourcing/battery_pack/rfq-response-pack.yaml` |
| Top/bottom interconnect | `Hirose_BM28_hybrid_power_signal_fpc_bridge_class` | `production/sourcing/split_interconnect/rfq-response-pack-intake-template.yaml` | `production/sourcing/top_bottom_interconnect/rfq-response-pack.yaml` |
| Audio/haptics flexes | `ALC5688_CS35L41_SPH0641LM4H_speaker_receiver_haptic_stack` | `production/sourcing/audio_haptics/rfq-response-pack-intake-template.yaml` | `production/sourcing/audio_speaker_microphone_flexes/rfq-response-pack.yaml` |
| PMIC | `DA9063_class` | none found | `production/sourcing/pmic/rfq-response-pack.yaml` |

## BOM Cost Rollup

Source: `board/kicad/e1-phone/off-the-shelf-sourcing-cost-model-2026-05-22.yaml`.

Scope: public-listing estimated material, PCBA, mechanical, factory-test, and consumable rollup. It excludes unreleased supplier quotes, tariffs, taxes, warranty, margin, and release evidence. Treat it as a budget model, not an AVL or PO.

| Units | Estimated per device | Estimated total | Discount vs single-unit reference |
| ---: | ---: | ---: | ---: |
| 100 | USD 308.68 | USD 30,868 | 43.3% |
| 1,000 | USD 223.44 | USD 223,440 | 59.0% |
| 10,000 | USD 161.96 | USD 1,619,600 | 70.3% |
| 100,000 | USD 124.01 | USD 12,401,000 | 77.2% |
| 1,000,000 | USD 101.05 | USD 101,050,000 | 81.4% |

Single-unit reference: USD 544.62.

Cross-check: `mechanical/e1-phone/review/bom-unit-cost.yaml` has a narrower ex-factory estimate of USD 123.90 at 10k and USD 93.03 at 100k, with component-only totals of USD 105.65 at 10k and USD 84.79 at 100k. The two files are directionally consistent but scoped differently. Neither is a production BOM/AVL.

## Marketplace Observations

These are current public marketplace signals, not supplier-approved quotes:

- Display/touch: Alibaba META Display 5.5 inch 1080x1920 MIPI 40-pin capacitive touch listing shows USD 10-15 and MOQ 1. It supports the budget class but is not a signed `CH550FH01A-CT` pack. Source: https://www.alibaba.com/product-detail/5-5-Inch-TFT-LCD-Display_1601425016323.html
- Rear camera: Alibaba OV13855 13MP MIPI listing shows USD 11.72 at 3-49 pcs, USD 10.18 at 50-999 pcs, and USD 8.79 at >=1000 pcs. Exact FPC, lens, AF, OTP, and tuning remain supplier-specific. Source: https://www.alibaba.com/product-introduction/Wholesale-Cheap-RK3588-OV13855-Sensor-13mp_1600288027905.html
- Front camera: Made-in-China GC5035 MIPI listing shows USD 5.50 at 1-499 pcs, USD 5.00 at 500-1999 pcs, USD 4.60 at 2000-9999 pcs, and USD 4.20 at 10000+ pcs. Source: https://www.made-in-china.com/video-channel/newmoshine_eQwUHydXrxWl_Af-Autofixed-Camera-Module-Gc5035-5MP-CMOS-Image-Sensor-Camera-Module-Mipi-Interface.html
- Cellular: 5GWAVE lists Quectel RG255C-GL mPCIe at USD 150 retail; Alibaba RedCap search results showed roughly USD 69.80-101.99 low-volume modules and USD 81-85 LGA at MOQ 2. High-volume LGA pricing must come from Quectel/channel. Source: https://5gwave.com/products/quectel-rg255c-gl-5g-redcap-mpcie
- Wi-Fi/BT: DigiKey lists Murata `LBEE5XV2EA-802` at USD 25.39 single, USD 19.49010 at 100, and USD 17.14116 at 1000. It is orderable, but firmware/regulatory/antenna approval still blocks release. Source: https://www.digikey.com/en/products/detail/murata-electronics/LBEE5XV2EA-802/22205340
- USB-C: DigiKey lists GCT `USB4105-GF-A` at USD 0.80 single, USD 0.57450 at 100, and USD 0.42165 at 8000. Good EVT candidate; still needs shell-stake drawing and aperture review. Source: https://www.digikey.com/en/products/detail/gct/USB4105-GF-A/11198510
- USB-PD: LCSC lists TI `TPS65987DDHRSHR` at USD 5.8471 single, USD 4.1239 at 100, and USD 3.807 at 1000. Buyable, but possibly over-capable for a USB2 charging-only architecture. Source: https://www.lcsc.com/product-detail/C2868843.html
- Compute: Firefly Core-3566JD4 docs confirm RK3566, LPDDR4/eMMC options, MIPI DSI/CSI, PCIe, SATA, USB, and 260-pin 0.5 mm SODIMM. I did not verify a current public price from the opened Firefly source. Source: https://www.t-firefly.com/product/core/core3566jd4.html

## Critical Assessment

The local CAD/KiCad package is useful for internal review, but it cannot close release intake. The blockers are external by nature: signed supplier data, selected vendor quotes, fabricator stackup approval, validated DRC/ERC on accepted production sources, measured first-article results, and clearance runs against supplier-approved geometry.

The highest BOM risks are cellular RedCap, compute architecture, display/touch, PCBA/HDI yield, and mechanical enclosure/tooling. The most buyable off-the-shelf parts are USB-C, Wi-Fi/BT, USB-PD, and generic camera/display classes. The least closed items are battery safety pack, RedCap module economics/certification, PMIC/compute architecture, exact FPC pinouts, and all supplier STEP/land-pattern approval.

## Next Unblocks

1. Fill the 13 supplier return archives with real signed response packs.
2. Generate ERC/DRC only from accepted production KiCad sources and archive JSON reports.
3. Replace the candidate BOM with a KiCad-exported production BOM/AVL with exact MPNs, lifecycle, MOQ, lead time, quote reference, and alternates.
4. Obtain fabricator, assembler, fixture, and enclosure-DFA quote packages against the released routed fabrication package.
5. Rerun routed STEP clearance using supplier-approved component geometry.
6. Build serialized first articles and archive traveler, fixture calibration, limits revision, operator, board serial, measured results, and disposition.
