# PMIC selection for Eliza E1 (2028 mobile-class SKU)

Status: `path_selected_blocked_until_vendor_procurement`

## Constraint

No open mobile-class PMIC IP exists. All Qualcomm RPMh / MediaTek MT63xx /
Apple / Samsung S2MPS PMICs are closed silicon with closed register maps.
Academic "open" PMIC papers and a small number of RISC-V-controlled industrial
parts (Silergy, Allwinner T536) do not cover the 16-rail mobile envelope at
the integration density required.

This rules out shipping the 2028 SKU with a single integrated open-IP PMIC.
We must pick one of three procurement paths.

## Path comparison

| Path | Description | Cost (NRE) | Time-to-FA | Risk |
| --- | --- | --- | --- | --- |
| **A. Catalog daughtercard (v0)** | 6-8 catalog buck/LDO ICs from Renesas/MPS/TI/Maxim on a daughtercard, controlled by Ibex PMC via SPMI v2.0 (with I2C fallback). | < $100k for proto BOM + board NRE | < 2 months from PMC firmware ready | LOW: catalog parts have published data sheets, qualification packs, public IBIS, public thermal models. |
| **B. Closed-IP license (v1 candidate)** | License Synaptics / Dialog / Qorvo mobile PMIC IP and integrate as separate package-in-package die. | $1M-3M license + IP integration NRE | 12-18 months | HIGH: closed register maps, NDA gates, must accept upstream vendor timing. |
| **C. Custom analog (v2 candidate)** | Hire analog team, tape out a dedicated PMIC on an older mixed-signal node (180 nm BCD / 65 nm), package alongside SoC. | $5M-15M | 24-36 months | VERY HIGH: requires analog team, separate tapeout, separate qualification, separate yield curve. |

## Selected path

**Path A (catalog daughtercard) is the v0 production path.**

Rationale:

- Mobile-class envelope at ~5 W peak / ~3.5 W sustained is well within the
  catalog mobile-PMIC envelope; multiple vendors ship single-die parts that
  can handle 4-6 rails each.
- Open SPMI v2.0 host implementation in Ibex PMC firmware is well-documented
  by the MIPI Alliance specification.
- Catalog parts come with foundry-validated IBIS/SPICE models, EM data,
  thermal datasheets, and qualification reports we can ingest directly into
  `pd/signoff/si-pi/` and `pd/signoff/pdn-current/`.
- Daughtercard physical separation isolates analog rail decisions from the
  digital tapeout schedule.

### BOM target (planning-only)

| Rail group | Catalog candidate (planning-only) | Notes |
| --- | --- | --- |
| `VDD_CPU_BIG`, `VDD_CPU_LITTLE`, `VDD_NPU` | Renesas RAA48-series / TI TPS6594x mobile buck (3-rail SiP) | DVFS via SPMI; one die covers three DVFS rails. |
| `VDD_GPU`, `VDD_SOC_FABRIC`, `VDD_SRAM` | Renesas RAA48-series / MPS MP8869 dual-buck | DVFS via SPMI. |
| LPDDR rail group | TI TPS6594x LPDDR companion | VDDQ + VDD1 + VDD2H/2L per JEDEC. |
| `VDD_AON`, `VDD_PMC`, `VDD_IO_18`, `VDD_IO_33` | Catalog LDOs + buck (TI / Maxim) | Always-on rails; LDO chosen for low quiescent. |
| `VDD_USB_PCIE_PHY`, `VDD_PHY_ANALOG`, `VDD_RF_REF` | Catalog low-noise LDOs (TI TLV/LT) | Low-noise analog reference. |

Specific part numbers are deferred until the daughtercard schematic owner
selects against signal integrity and qualification reports.

## Interface contract

- **SPMI v2.0 master** in Ibex PMC firmware (`fw/pmc/src/spmi.c`).
- **I2C fast-mode-plus fallback** for bring-up board (`fw/pmc/src/i2c.c`).
- **Per-rail enable lines** to PMC GPIO (`pmic_enable_o[15:0]` in
  `rtl/power/pmc_top.sv`).
- **DVFS command flow:** Linux cpufreq -> SBI MPxy -> RPMI v1.0 -> Ibex PMC
  firmware -> SPMI transaction -> external buck/LDO programming registers.

## v1 / v2 deferred items

- Path B (closed-IP license) is the v1 candidate; revisit when shipment
  volume justifies NRE and we can negotiate IP terms.
- Path C (custom analog) is the v2 candidate; only justified if our annual
  shipment volume crosses 10M units.

## Release blockers

- Specific catalog part numbers not selected.
- Daughtercard schematic not in `board/kicad/`.
- SPMI v2.0 master firmware absent beyond the checked-in bring-up scaffold
  (source lives in
  `fw/pmc/src/spmi.c`).
- Qualification package import (IBIS/SPICE/thermal) not landed in
  `pd/signoff/si-pi/package-models/`.

## References

- MIPI SPMI v2.0 specification
- Renesas RAA489000 / TI TPS6594x datasheets (planning-only)
- Qualcomm PMK8550 / PM8550 family teardown (rejected, closed silicon)
