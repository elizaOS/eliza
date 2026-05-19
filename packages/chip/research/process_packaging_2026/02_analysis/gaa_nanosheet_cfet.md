# Device Architecture Trajectory: FinFET to GAA Nanosheet to CFET

Date: 2026-05-19

Scope: track the device-architecture trajectory across the 2028 window for a
14A-class mobile SoC. Sources: IRDS 2024 More Moore, TSMC N2 / A16 / A14
public pages, Intel 18A / 14A public pages, Samsung SF2 page and IEDM 2023
BSPDN paper, imec forksheet / CFET / 2D-material research summaries.

## Generation Map (Public Foundry Statements, 2024--2026)

| Foundry  | Node       | Device           | Backside PDN              | Public Production Window |
|----------|------------|------------------|---------------------------|--------------------------|
| TSMC     | N3 / N3P   | FinFET (FinFLEX) | no                        | shipping 2023--2026      |
| TSMC     | N2         | Nanosheet (GAA)  | no (frontside)            | risk 2025, HVM 2026      |
| TSMC     | N2P        | Nanosheet (GAA)  | optional Super Power Rail | 2026/2027                |
| TSMC     | A16        | Nanosheet (GAA)  | Super Power Rail (base)   | 2026 H2 / 2027           |
| TSMC     | A14        | Nanosheet gen-2  | SPR refined               | 2027/2028 ramp           |
| Intel    | 18A        | RibbonFET (GAA)  | PowerVia (base)           | risk 2024, HVM 2025      |
| Intel    | 18A-P / PT | RibbonFET        | PowerVia                  | 2025--2026               |
| Intel    | 14A        | RibbonFET 2      | PowerDirect (base)        | 2027/2028 ramp           |
| Samsung  | SF3        | MBCFET (GAA)     | no                        | shipping 2022--2024      |
| Samsung  | SF2        | MBCFET gen-2     | optional (SF2Z follow-on) | 2025/2026                |
| Samsung  | SF1.4      | MBCFET gen-3     | BSPDN                     | 2027 announced           |
| Rapidus  | 2 nm       | Nanosheet        | option in roadmap         | 2027 pilot / 2027--2028  |

References: `tsmc_n2_overview`, `tsmc_a16_announcement`, `tsmc_a14_roadmap`,
`intel_foundry_18a`, `intel_foundry_14a`, `samsung_foundry_sf2`,
`samsung_bspdn_iedm2023`, `rapidus_2nm`. These dates and option names are
quoted from public foundry pages and press; they are planning context, not
confirmed PDK availability for E1.

## Nanosheet / GAA Vs FinFET

Per IRDS 2024 More Moore (`irds_2024_more_moore`):

- The first 20A / 2 nm-class nodes replace the FinFET with stacked horizontal
  nanosheets, gated on all four sides. The width of each sheet (W_eff) is a
  per-cell design variable (TSMC NanoFlex, Samsung MBCFET sheet-width
  control), not a fixed quantum like fin count.
- Threshold-voltage multi-Vt is implemented through work-function-metal stacks
  inside the gate-all-around channel, and is the primary lever the foundry
  offers the library team for high-speed vs low-leakage cells.
- Effective channel width per area increases vs FinFET because the channel is
  3D-wrapped. This recovers some of the drive-current loss expected at the
  ~45 nm CPP / ~20 nm MMP node generation.

Consequences for E1 logic at 14A-class (must-model entries in
`process-14a-effects.yaml: nanosheet_device_variability`):

- SS/TT/FF plus local Monte Carlo variation must be sampled per-sheet because
  sheet-width quantization and edge-roughness contribute to a different
  variability profile than FinFET fin counts.
- Vmin spread increases for SRAM and near-threshold logic; Vmin-recovery
  assist circuits are reported as standard in the TSMC 2 nm and Samsung 2 nm
  SRAM macro papers (`tsmc_2nm_sram_iedm2023`, `samsung_2nm_sram_isscc2024`).
- Self-heating per device increases roughly 2x vs FinFET (see
  `self_heating_nanosheet_edl2024`) because the wrap-gate dielectric stack
  reduces lateral heat conduction. This couples device aging to local
  activity factor more tightly than at N5/N3.

## NanoFlex / FinFLEX-Style Cell Flexibility

`tsmc_nanoflex` and `samsung_finflex` describe how the foundry exposes
multiple cell heights and channel widths within a single mask set:

- Tall-cell, wide-sheet cells deliver higher drive current at the cost of
  cell area and dynamic energy. Used for clock tree, critical-path datapath,
  and high-fanout buffers.
- Short-cell, narrow-sheet cells deliver higher density and lower leakage,
  used for control logic and background fabric.
- The library tool flow must be NanoFlex-aware. Placement and synthesis
  decisions about which variant to use happen at PD time, not at RTL time.

For E1, this implies the standard-cell selection is a per-block decision and
must be tied to the `interconnect_rc_and_congestion` and
`self_heating_and_power_density` effects: high-toggle NPU MAC arrays will
likely use a different sheet-width / cell-height than CPU control logic.

## Forksheet (Intermediate Scaler)

`imec_forksheet` describes the forksheet device: dielectric wall between the
n-FET and p-FET sheets to reduce n--p spacing without merging the channels.

- Forksheet is presented in research literature as a 2 nm-to-A14 transitional
  step but no foundry has publicly committed it to HVM as of 2026-05.
- For E1, forksheet is not in the candidate set unless a foundry partner
  exposes it through a PDK option. It is tracked here only because IRDS 2024
  references it on the More Moore device-architecture path.

## CFET (Complementary FET) -- 2030+ Direction

`imec_cfet_2023` reported a working stacked nFET-on-pFET CFET prototype on
300 mm at IEDM 2023.

- CFET stacks p over n vertically, sharing the gate stack. The published
  area-scaling claim is ~30--50% vs nanosheet for inverter / SRAM cells.
- The first credible foundry CFET node is consistently placed beyond 2028 in
  vendor roadmaps. TSMC has not announced a CFET node; Intel discussions
  reference CFET "post-14A". Samsung and Rapidus reference research-stage
  only.

For E1's 2028 production-assumption target, CFET is **out of scope** as a
device option. It is included here as forward planning context only.

## 2D-Material Channel MOSFETs (MoS2, WSe2, TMDs)

`2d_material_mosfet_iedm` summarizes the imec / TSMC research-consortium
state on 2D-channel transistors.

- Wafer-scale MoS2 demonstrations exist; WSe2 used as p-FET counterpart in
  CMOS pairings.
- Sub-1 nm body thickness mitigates short-channel effects; metal-channel
  contact resistance remains the dominant performance limit.
- No public foundry has announced a 2D-channel node before 2030.

For E1, 2D-material MOSFETs are also out of scope as a primary channel
material. They are watched as a possible follow-on for >2030 successor.

## Implications For The E1 Process-Effects Contract

Tied to `docs/spec-db/process-14a-effects.yaml` entries:

- `nanosheet_device_variability`: the contract is correct to demand SS/TT/FF
  plus local variation corners for nanosheet width and Vth -- this is
  consistent with the variability profile reported by the 2 nm SRAM papers
  and IRDS 2024 More Moore.
- `node_identity_and_pdk_binding`: NanoFlex / sheet-width / Vt selection
  must be part of the library manifest, not implied by a marketing node
  name. The contract's `selected_process_option` field is the right place
  for this.
- `self_heating_and_power_density`: nanosheet ~2x self-heating per device
  (`self_heating_nanosheet_edl2024`) supports the contract's per-block
  activity-factor and thermal-path requirement. CFET, when it arrives, will
  worsen this further.
- `sram_density_vmin_and_ecc`: TSMC 2 nm and Samsung 2 nm SRAM bitcell
  papers confirm assist circuits + ECC + repair are required to achieve
  Vmin and yield on dense local SRAM. The contract's required evidence
  (`docs/arch/memory-subsystem.md`, `docs/arch/npu-microarch.md`) is the
  right binding for these macros.

The forksheet, CFET, and 2D-channel paths are explicitly NOT in the E1 2028
device candidate set. Any future research that proposes them must reopen
`process-14a-effects.yaml` and add a new minimum_supported_variant entry.
