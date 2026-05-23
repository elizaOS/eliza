# E1 Phone Off-The-Shelf Sourcing Cost Model - 2026-05-22

Status: **public listing cost model, not AVL/PO ready**.

This review covers public marketplace and distributor evidence for the major
buyable modules and commodity parts, plus estimated COGS by volume. It excludes
NRE, tooling amortization, freight, tariffs, taxes, warranty reserve, margin,
cash terms, and certification programs.

## Rollup

| Units | Est. per-device cost | Discount from single unit |
| ---: | ---: | ---: |
| 1 | $544.62 | 0.0% |
| 100 | $308.68 | 43.3% |
| 1,000 | $223.44 | 59.0% |
| 10,000 | $161.96 | 70.3% |
| 100,000 | $124.01 | 77.2% |
| 1,000,000 | $101.05 | 81.4% |

## Critical Findings

- The current 5.5 inch display direction is plausible: Chenghao CH550FH01A-CT
  has a public Made-in-China price ladder and dimensional data, while META
  055WU01 provides an Alibaba high-brightness 40-pin alternate. Neither is a
  production BOM line until signed drawings, FPC exits, touch controller data,
  and STEP models are returned.
- The rear and front camera module families are buyable public module classes,
  but the exact module drawing, FPC pinout, lens z-height, optical-center datum,
  OTP/calibration, and driver support remain blockers.
- Cellular is the biggest cost and certification risk. RG255C RedCap is
  technically attractive but expensive; EG915Q/EG916Q Cat 1 bis should remain a
  cost-down branch if lower throughput is acceptable.
- Murata Type 2EA is a strong Wi-Fi/Bluetooth module choice with official module
  dimensions and distributor price signals, but firmware licensing, regulatory
  scope, reference layout, and antenna coexistence still block release.
- USB-C is one of the strongest off-the-shelf lines: GCT USB4105 has distributor
  availability and public price breaks. Exact variant, STEP, footprint, and
  mechanical retention still need to be frozen.
- Battery sourcing must remain safety-gated. Public 5000 mAh Li-polymer packs
  exist, but the target pack is still custom until pack drawing, PCM, NTC,
  UN38.3/MSDS/IEC62133, sample capacity, and abuse evidence are in hand.
- The compute SoC/module and routed PCBA remain low-confidence cost items until
  the production silicon/module choice and routed KiCad BOM exist.

## CAD Actions

- Added visible concept PCB/module detail: cellular LGA module envelope, Wi-Fi/BT
  module envelope, SoC/DRAM/storage/PMIC/RF package markers, GNSS LNA marker,
  and RF feed stubs.
- Added STEP-exported concept envelopes for the new PCB/module markers so the
  review CAD is more complete while still blocked on supplier STEP.
- The CAD still correctly treats these as concept geometry; production release
  remains blocked until supplier STEP/B-rep and routed-board STEP replace the
  placeholders.

Machine-readable source: `off-the-shelf-sourcing-cost-model-2026-05-22.yaml`.
