# High-NA EUV Lithography And DTCO / STCO For 14A-Class

Date: 2026-05-19

Scope: status of High-NA EUV tools, pitch trajectories, single vs
multi-patterning at A14/A10, and the DTCO/STCO levers (cell-height, COAG,
NanoFlex, BSPDN-enabled cell shrink) that the foundries are using to
continue density scaling at 14A-class.

Sources: `asml_high_na_exe5000`, `asml_high_na_exe5200`, `imec_high_na_status`,
`irds_2024_lithography`, `irds_2024_more_moore`, `synopsys_dtco_overview`,
`cadence_stco_overview`, `tsmc_nanoflex`, `samsung_finflex`,
`tsmc_n2_overview`, `intel_foundry_14a`.

## EUV Status Recap

- Standard EUV (NA 0.33) is the production tool for N5/N4/N3/N2 critical
  layers. Multi-pattern EUV is used where pitch falls below single-expose
  reach (~30 nm half-pitch).
- High-NA EUV (NA 0.55, ASML EXE:5000 / EXE:5200) extends single-exposure
  reach toward sub-10 nm half-pitch. The first EXE:5000 was installed at
  imec / Intel in 2023--2024; EXE:5200 ramp targets HVM in 2025--2026.
- Hyper-NA (>0.55) is in early ASML research roadmap; not credible for the
  2028 production window.

## Pitch Trends At A14-Class

Per `irds_2024_more_moore` and `irds_2024_lithography`:

- Contacted poly pitch (CPP): targets in the ~45 nm region at A14-class,
  from ~48 nm at N2.
- Minimum metal pitch (MMP): ~20--22 nm region for M0/M1 layers at A14,
  from ~23--25 nm at N2.
- These pitches are at or near the single-expose limit of NA 0.33 EUV.
  Single-expose High-NA is the only credible path to keep mask count and
  cycle time bounded at these dimensions, otherwise multi-pattern EUV is
  required.

Foundry adoption signals:

- TSMC has publicly stated High-NA EUV will be used at A14-class and beyond
  but has not committed it to N2 base flow. N2 uses NA 0.33 EUV multi-patterning
  where required.
- Intel has publicly committed High-NA EUV adoption at 14A.
- Samsung positions High-NA at SF1.4 with potential SF2 introduction on
  specific layers.

## Stochastic Defectivity And Mask 3D Risk

`irds_2024_lithography`, `imec_high_na_status`:

- Stochastic defectivity (random missing-contact / extra-contact patterns
  from photon shot noise at low-dose EUV) is the dominant HVM risk at
  High-NA. Resist thinness (<30 nm) is required to avoid aspect-ratio
  collapse but worsens shot-noise.
- Mask 3D effects (mask topography modulating the printed pattern) are more
  pronounced at NA 0.55 anamorphic optics; OPC and inverse-lithography
  approaches must be updated.
- These are tool / process risks; they affect E1 schedule and cost via the
  foundry, not directly via E1 RTL/PD. They are noted here so that any E1
  cost / schedule projection at A14-class includes a stochastic-yield risk
  flag.

## DTCO Levers

`synopsys_dtco_overview`, `cadence_stco_overview`, `tsmc_nanoflex`,
`samsung_finflex`:

### Cell-Height Reduction

- N5/N4 standard cells: ~6T height.
- N3 / SF3: ~5T height.
- N2 / SF2 / 18A: ~4.5T toward ~4T with NanoFlex / FinFLEX / DTCO levers.
- A14 / SF1.4 / 14A: targets ~4T or below, enabled by BSPDN freeing M0
  power rails.

The cell-height drop is the largest area-density lever between N3 and
A14-class, more than the lithographic pitch shrink. BSPDN is a prerequisite
for sub-4.5T at HVM-credible yield because frontside PDN consumes too much
of the cell.

### Contact-Over-Active-Gate (COAG)

- COAG places the gate contact directly over the active region of the cell
  instead of an extension region. It was first used at Intel 10 nm /
  follow-on FinFET nodes and is now standard at sub-2 nm.
- BSPDN enables more aggressive COAG because the M0 / VDD-VSS routing is
  no longer competing for the same area.
- COAG and BSPDN together are the two main DTCO area-scaling enablers
  cited in `synopsys_dtco_overview`.

### NanoFlex / FinFLEX Cell Variants

- TSMC NanoFlex (`tsmc_nanoflex`): per-cell selection of nanosheet width
  and Vth.
- Samsung FinFLEX / nanosheet equivalent (`samsung_finflex`): per-cell
  selection of channel count and Vth.
- These do not change cell-height -- they change the drive strength /
  leakage tradeoff inside a fixed cell footprint.
- Library and PD flow must be NanoFlex-aware: which variant is used at
  each gate is a synthesis decision, not an RTL decision.

### Local Decap And Library Decap Cells

- BSPDN reclaims frontside area for signal routing and on-die decap. The
  decap cell library at A14-class is larger and includes finer-grained
  decap variants per Synopsys/Cadence DTCO documentation.
- For E1: decap planning must be tied to the selected PDN variant. A
  frontside-PDN E1 floorplan has less area for on-die decap than a BSPDN
  variant.

## STCO -- System-Technology Co-Optimization

`cadence_stco_overview`, `irds_2024_packaging`:

- STCO extends DTCO past the standard cell to the package, chiplet
  partitioning, and board.
- Examples cited in industry whitepapers: choosing chiplet boundaries that
  align with thermal hot-spot boundaries; co-designing PHY pitches with
  package routing; placing memory PHY near package-side bumps to reduce
  signal-integrity engineering.
- For E1: STCO is the framework that ties this packet's process work to
  `02_analysis/advanced_packaging_and_chiplet.md` and to the existing
  `docs/architecture-optimization/phone-platform.md`.

## Implications For E1 process-14a-effects.yaml

Tied to `node_identity_and_pdk_binding`, `interconnect_rc_and_congestion`:

- The contract correctly demands a selected library and corner manifest
  before claims. NanoFlex / FinFLEX selection is part of the **library
  selection**, not part of node identity. The contract field
  `standard-cell, SRAM, IO, ESD, and analog library versions` is the
  right home for this.
- The contract correctly demands extracted RC across corners
  (`extracted_rc_and_routing_congestion_evidence_missing`). RC at A14-class
  is dominated by interconnect, not by gate delay -- particularly because
  Mo/Ru BEOL behaves differently from Cu (see `irds_2024_beol`,
  `em_advanced_beol_tdmr2024`).
- E1 PD flow must be COAG/NanoFlex-aware at synthesis time, not retrofitted
  after place-and-route. This is a library-flow constraint, not an RTL
  constraint.

## E1 Lithography / DTCO Path

- **Assume** High-NA EUV used by the foundry on critical layers at A14;
  do not encode High-NA explicitly in E1 evidence -- it is a foundry
  responsibility, surfaced through the PDK + library + signoff manifest.
- **Plan** for ~4--4.5T cell height with NanoFlex-style variant selection.
- **Treat** stochastic defectivity as a yield-evidence requirement and not
  a design-time choice; the foundry yield-learning telemetry is the only
  credible source. This binds to the contract's
  `dft_yield_and_debug_lock` effect.
- **Do not claim** specific density numbers (logic density, SRAM bitcell
  area) until the foundry library is selected and characterized.
