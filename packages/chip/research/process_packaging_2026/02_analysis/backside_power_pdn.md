# Backside Power Delivery, PDN, IR-Drop, And Thermal Effects

Date: 2026-05-19

Scope: compare frontside power delivery vs backside power delivery options
available at the 14A-class generation, and identify the IR-drop, EM, signal
routing, decap, and thermal-asymmetry consequences for a 2028 mobile SoC.

Sources used: `imec_backside_pdn_dtco`, `intel_powervia_vlsi2023`,
`tsmc_super_power_rail`, `samsung_bspdn_iedm2023`, `irds_2024_more_moore`,
`irds_2024_packaging`, `irds_2024_beol`, `synopsys_dtco_overview`.

## Frontside PDN (Baseline)

In frontside PDN, power and signal share the same metal stack. Vdd and Vss
are delivered through the top thick metal layers, traveling down through the
stack to the M0/M1 cells. This means:

- The top 2--3 thick metal layers (Mx, Mz) are dominated by power grids,
  reducing available signal routing area.
- IR-drop budget is tight at advanced nodes because the grid resistance is
  set by feasible top-metal pitch + via-stack resistance.
- Standard-cell M0/M1 power rails consume a significant fraction of the cell
  area, gating cell-height reduction (`synopsys_dtco_overview`).
- Decap planning is straightforward but on-die capacitance is limited by
  available frontside metal area; package decap dominates the high-frequency
  PDN response.

This is the **assumed E1 base option** per
`process-14a-effects.yaml: frontside_pdn_a14_class`. PD must produce IR/EM
evidence at this configuration before any BSPDN claim.

## Backside PDN -- Three Variants

Three foundry implementations of backside PDN exist or are publicly
documented for 2025--2028:

### Intel PowerVia (18A) And PowerDirect (14A)

`intel_powervia_vlsi2023` and `intel_foundry_18a` describe PowerVia:

- Power is routed on a dedicated metal stack on the **wafer backside** after
  wafer thinning + backside metallization.
- Connections to source/drain pads use deep TSV-like via structures (the
  "PowerVia") drilled from the backside.
- Reported test-chip results: ~5--10% standard-cell utilization gain and
  ~30 mV reduction in voltage droop at iso-frequency, plus measurable
  thermal-design simplifications because the power grid is no longer
  competing for top-metal routing area.
- Intel 14A's evolved variant ("PowerDirect", `intel_foundry_14a`) increases
  the backside contact density and is the base PDN option, not optional.

### TSMC Super Power Rail / SPR (A16, A14)

`tsmc_a16_announcement`, `tsmc_super_power_rail`:

- SPR adopts a backside metal stack with bottom-side contacts that land on
  source/drain pads.
- Public TSMC claims for A16 vs N2P (`tsmc_a16_announcement`): ~8--10%
  speed gain at iso-Vdd, ~15--20% power reduction at iso-frequency, and
  ~1.07--1.10x logic density.
- TSMC presents SPR as one of the headline differentiators of A16 vs base
  N2; A14 carries it forward with refinements. SPR is **not** an N2 base
  option per public statements; N2P is the optional variant.

### Samsung BSPDN (SF2Z / SF1.4)

`samsung_bspdn_iedm2023`:

- Samsung demonstrated BSPDN on a 2 nm-class SRAM testchip at IEDM 2023.
- Backside metal stack carries Vdd/Vss; nano-TSV-like vias land on
  source/drain pads.
- Reported routing-congestion relief and IR-drop improvement specifically on
  SRAM periphery. Samsung's public roadmap places BSPDN as an SF2 follow-on
  (SF2Z) and a base SF1.4 feature.

### imec Buried Power Rail + Nano-TSV

`imec_backside_pdn_dtco`:

- imec's open research DTCO study compared BPR (buried power rail in front-
  end-of-line, no backside metal stack) vs full BSPDN with nano-TSV.
- Full BSPDN reported up to ~30% routing-congestion relief on frontside
  metal and ~50% IR-drop reduction on dense logic vs frontside-only PDN.
- The imec study is the canonical open-literature reference for any team
  modeling BSPDN tradeoffs before signing a foundry PDK.

## DTCO Implications (Cell Height, Routing, Decap)

`synopsys_dtco_overview`, `cadence_stco_overview`:

- Backside PDN frees M0/M1 power rails inside the cell. Cell heights can
  drop from ~5T toward ~4.5T and, with COAG, toward 4T at A14-class.
- Contact-over-active-gate (COAG) is more usable when power is on the
  backside because the gate contact no longer competes with power rails on
  the cell's M0 layer.
- Decap planning changes: frontside decap area is reclaimed for signal
  routing, but backside decap requires backside MIM caps or backside trench
  capacitors, which are foundry-option-specific.

## EM, Reliability, And Thermal Asymmetry

- EM activation energies and current-density limits change because the
  metal stack carrying high currents is now closer to the active devices,
  with different temperature, geometry, and barrier behavior. `irds_2024_beol`
  flags Mo/Ru as the candidate metals; `em_advanced_beol_tdmr2024` reports
  Mo/Ru without liner can carry higher current density than Cu at narrow
  lines, which is favorable for backside power rails.
- Thermal flux now travels primarily through the package interconnect side
  (heat exits via backside metal + nano-TSV stack toward the die backside,
  which is also the package thermal interface). On a phone-class package,
  this is favorable because the die backside is the thermal output anyway.
  On a 3D-stacked package, this is a concern because the backside is no
  longer free for heat extraction.
- Self-heating per device (see `gaa_nanosheet_cfet.md`) is roughly 2x
  FinFET in the nanosheet baseline. BSPDN amplifies the importance of
  modeling **direction** of heat flux: in a frontside-PDN floorplan, the
  thermal model can treat the package backside as the cold side; in a
  BSPDN floorplan, the model must explicitly include the backside metal +
  via thermal resistance.

## Cost / Schedule Considerations

Public foundry statements:

- BSPDN adds wafer-thinning, backside lithography, and backside
  metallization steps. TSMC and Intel have publicly described BSPDN as
  cost-additive in absolute terms but PPA-positive enough that A16-class
  customers should take it on board.
- BSPDN yield in mobile-volume production has not been independently
  reported by 2026-05. Intel 18A is the first BSPDN node expected to ramp
  to volume, with A16 / SF1.4 / SF2Z to follow.

## Implications For E1's process-14a-effects.yaml

Tied to `frontside_vs_backside_power_delivery` (required_effect):

- The contract is correct to require both a frontside-PDN base option
  and a BSPDN follow-on as **separate variants**. They are not equivalent
  in IR, EM, routing congestion, cell-height, or thermal-flux behavior.
- Required evidence list (`pd/signoff/pdn-current/local-budget.yaml`,
  `benchmarks/power/local-estimates/e1-npu-openlane-npu-estimates.json`)
  must be produced under **each** variant before any PDN-related claim is
  released. A frontside-PDN signoff cannot be transferred to a BSPDN
  variant by reasoning alone -- the PD flow, IR analysis, cell-library,
  and thermal model differ.
- The contract's `blocker: process_variant_pdn_tradeoff_evidence_missing`
  is the correct fail-closed state.

## E1 Path Recommendation

- **Baseline:** assume frontside PDN at A14-class as the default planning
  target for 2028. This is consistent with `tsmc_a14_roadmap` (A14 retains
  SPR but a frontside-PDN sibling option may be offered for
  cost-sensitive mobile), and with the contract's
  `frontside_pdn_a14_class` minimum variant.
- **Backside option:** carry a parallel BSPDN variant (TSMC SPR, Intel
  PowerDirect, Samsung BSPDN) in planning evidence with a separate IR /
  EM / thermal model. Treat any PPA claim from this variant as conditional
  until a foundry PDK gates it.
- **Do not claim** that BSPDN automatically gives E1 the public-vendor PPA
  deltas. Those numbers are reported on vendor test designs, not on E1.
