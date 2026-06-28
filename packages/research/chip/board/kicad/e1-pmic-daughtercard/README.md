# E1 PMIC daughtercard — catalog BOM (planning only)

Status: `path_selected_blocked_until_vendor_procurement`

This daughtercard implements **Path A** from `docs/pd/pmic-selection.md`: a
catalog buck/LDO assembly that supplies the 16-rail plan in
`docs/pd/rail-plan-2028.yaml`. The card is intended to dock to the main demo
board via a board-to-board connector carrying SPMI v2.0 (primary), I2C-FM+
(fallback), and the 16 per-rail enable lines from `pmc_top.pmic_enable_o`.

> **Not for fabrication.** No KiCad schematic / PCB files are produced yet;
> this directory currently holds only the planning BOM and the contract that
> binds it to the rail plan. A KiCad schematic must be authored before any
> Gerbers can be generated. ERC/DRC have NOT been run.

## Sources of authority

| Authority | Path |
| --- | --- |
| Rail plan (voltages, currents, decoupling targets) | `docs/pd/rail-plan-2028.yaml` |
| Selection rationale | `docs/pd/pmic-selection.md` |
| Procurement gate | `docs/evidence/power/pmic-procurement.yaml` |
| PMC firmware contract | `docs/pd/power-management-firmware.md` |
| PMC RTL pin contract | `rtl/power/pmc_top.sv` |

## Vendor candidates (single-source per rail group)

The BOM in `bom-planning.csv` is one concrete instance of the catalog options
in `docs/pd/pmic-selection.md`. Any of the four vendor families below can
satisfy the envelope; the daughtercard owner picks the family that best
matches the supply chain at procurement time.

| Vendor | Family | Primary use |
| --- | --- | --- |
| Renesas | RAA221xxx mobile PMIC (e.g. RAA489000) | Multi-rail SiP for SoC core rails |
| MPS | MP5xxx / MP8869 high-density buck | Per-rail or dual-output buck |
| Texas Instruments | TPS6594x mobile PMIC | LPDDR companion + multi-rail |
| Maxim | MAX77xxx mobile PMIC | LDO array + always-on rails |

No part numbers below are committed; they are illustrative of the catalog
envelope. Procurement and qualification packages must be imported into
`pd/signoff/si-pi/package-models/pmic/` before any one is fixed in the BOM.

## Rail group mapping

The 16-rail plan groups into four physical regulator clusters on the
daughtercard to minimise the number of PMIC SiPs:

| Cluster | Rails covered | Candidate part (planning only) | Topology |
| --- | --- | --- | --- |
| SOC core | `VDD_CPU_BIG`, `VDD_CPU_LITTLE`, `VDD_NPU`, `VDD_GPU`, `VDD_SOC_FABRIC`, `VDD_SRAM` | Renesas RAA489000 + RAA48xxx companion | 6 DVFS bucks, SPMI controlled |
| LPDDR companion | `VDD_LPDDR_VDDQ`, `VDD_LPDDR_VDD1`, `VDD_LPDDR_VDD2H_2L`, `VDD_PHY_ANALOG` | TI TPS65941 LPDDR companion | 1 dual-buck + 2 LDO |
| Always-on / IO | `VDD_AON`, `VDD_PMC`, `VDD_IO_18`, `VDD_IO_33` | Maxim MAX77860 + MAX1771x LDO | 1 buck + 3 LDO |
| RF / PHY analog | `VDD_USB_PCIE_PHY`, `VDD_RF_REF` | TI TPS7A39 low-noise dual LDO | 2 LDO |

## Control interface

- **SPMI v2.0 master** from the SoC PMC drives the SOC core cluster.
- **I2C-FM+ fallback** on the bring-up board allows direct bench programming.
- **Per-rail enable lines** from `pmic_enable_o[15:0]` are routed to the
  daughtercard via the board-to-board connector. The mapping is documented
  one-to-one against `docs/pd/rail-plan-2028.yaml::rails[].index` so a single
  bit-flip in PMC firmware drives the matching regulator.

## Release blockers

- [ ] KiCad schematic not authored. Once selected, populate this directory
      with `e1-pmic-daughtercard.kicad_pro` / `.kicad_sch` / `.kicad_pcb`.
- [ ] Specific catalog part numbers not committed; BOM is planning-only.
- [ ] Qualification packages (IBIS / SPICE / thermal) not imported into
      `pd/signoff/si-pi/package-models/pmic/`.
- [ ] Daughtercard connector pin-out not finalised.
- [ ] Per-rail decoupling layout not produced; the board_target_nf column in
      `bom-planning.csv` enumerates the count required from the rail plan.
- [ ] ERC / DRC not run (no schematic exists yet).

## Verification

```sh
python3 scripts/check_pmic_daughtercard_bom.py
```

The checker confirms that:

1. Every rail in `docs/pd/rail-plan-2028.yaml` has at least one BOM row whose
   declared `rail` field matches.
2. The declared `vmin_v` / `vmax_v` covers the `dvfs_min_v` / `dvfs_max_v`
   of the rail.
3. The declared `i_max_a` is greater than or equal to the rail's `peak_a`.
4. The declared `control` field is one of `spmi_v2`, `i2c_fmplus`, or
   `enable_pin_only`.
