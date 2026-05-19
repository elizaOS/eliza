# Process / Packaging Path For Eliza E1 -- Ranked Recommendations

Date: 2026-05-19

This plan applies the research in `02_analysis/*.md` and the source inventory
in `01_sources/source_inventory.yaml` to the open work order in
`docs/spec-db/process-14a-effects.yaml`. Recommendations are ordered by
confidence and are explicitly keyed to `required_effects` entries.

## Confidence Levels

- **High** confidence: directly justified by IRDS 2024 + foundry public
  statements + open research (imec / IEDM / ISSCC / VLSI) cited in the
  source inventory; should be implemented as evidence work.
- **Medium** confidence: directly justified by the same sources but
  depends on a foundry-PDK decision before becoming actionable.
- **Low** confidence: forward planning only; do not adopt until the
  underlying technology graduates into a foundry option.

## High-Confidence Recommendations (Implement Now)

### H1. Keep frontside-PDN as the baseline planning variant; carry BSPDN as a parallel variant

Binding: `required_effects.frontside_vs_backside_power_delivery`.

Sources: `intel_powervia_vlsi2023`, `tsmc_super_power_rail`,
`samsung_bspdn_iedm2023`, `imec_backside_pdn_dtco`.

Action:
- Keep the contract's `minimum_supported_variants`:
  - `frontside_pdn_a14_class`
  - `backside_pdn_or_super_power_rail_follow_on`
- Make sure PD signoff manifests, IR/EM analysis, and thermal models
  exist under **each** variant before any PDN-related claim. The current
  blocker (`process_variant_pdn_tradeoff_evidence_missing`) stays in
  effect.
- Do not migrate PD signoff between variants by inference; redo IR/EM
  per variant.

### H2. Bind NanoFlex / FinFLEX library variant selection to the standard-cell library manifest

Binding: `required_effects.node_identity_and_pdk_binding`.

Sources: `tsmc_nanoflex`, `samsung_finflex`, `synopsys_dtco_overview`.

Action:
- The `must_model.standard-cell, SRAM, IO, ESD, and analog library versions`
  bullet should be implemented as a versioned library manifest that
  records the NanoFlex (or vendor equivalent) variant per standard cell
  used in PD. This is part of the library selection, not part of node
  identity.
- Add a row to `docs/manufacturing/product-feature-evidence-manifest.yaml`
  if not already present: `library_variant_manifest_present`.

### H3. Adopt nanosheet-specific reliability derates in `reliability_aging_and_lifetime`

Binding: `required_effects.reliability_aging_and_lifetime`.

Sources: `bti_nanosheet_ted2023`, `self_heating_nanosheet_edl2024`,
`em_advanced_beol_tdmr2024`, `irds_2024_more_moore`.

Action:
- When the foundry PDK is selected, the lifetime derate evidence must
  use nanosheet BTI, nanosheet self-heating, and Mo/Ru BEOL EM rules
  rather than FinFET-era derates.
- Add an evidence gate in `docs/manufacturing/real-world-verification-gaps.yaml`
  if not already present: `nanosheet_aging_derate_from_pdk_present`.

### H4. SRAM Vmin / ECC / repair plan must include latch-FIT and bit-interleaving policy

Binding: `required_effects.sram_density_vmin_and_ecc`.

Sources: `tsmc_2nm_sram_iedm2023`, `samsung_2nm_sram_isscc2024`,
`soft_error_advanced_node_iolts2024`.

Action:
- Update `docs/arch/memory-subsystem.md` and `docs/arch/npu-microarch.md`
  guidance to spell out:
  - SECDED for L1/L2/NPU local SRAM,
  - parity or ECC on flop-heavy pipelines (NPU accumulators, CPU rename/
    ROB),
  - bit-interleaving in the SRAM macro layout to bound MBU,
  - repair fuse + redundancy policy and BIST coverage.
- Treat per-bit FIT and latch FIT as separate budgets in the analysis.

### H5. Workload-correlated thermal capture must distinguish transient vs sustained envelope

Binding: `required_effects.self_heating_and_power_density`.

Sources: `vapor_chamber_phone_review`, `aosp_thermal_hal`,
`aosp_thermal_mitigation`, `self_heating_nanosheet_edl2024`.

Action:
- The existing `docs/manufacturing/evidence/thermal/e1-npu-thermal-capture-plan.md`
  capture template should explicitly split:
  - vapor-chamber transient phase (10--30 s; ~4--8 W absorbed),
  - vapor-chamber post-saturation steady-state phase (~4--6 W),
- and require sustained TOPS/W to be reported only from the post-
  saturation phase.
- The skin-temperature limit (43--45 C per IEC 60950-1 / IEC 62368-1) is
  the stop condition; this is consistent with the existing operating-point
  work order at `<= 95 C` die.

### H6. Default to monolithic die + on-package LPDDR5X / LPDDR6; treat chiplet as a separate variant

Binding: `required_effects.node_identity_and_pdk_binding`,
`docs/manufacturing/board-package-2028-scaling-checklist.yaml`.

Sources: `intel_lunar_lake`, `snapdragon_x_elite`, `apple_m_ultra_fusion`,
`tsmc_info`, `jedec_lpddr5x_lpddr6`.

Action:
- Keep monolithic die + InFO_oS-class memory-on-package as the E1 2028
  baseline.
- Any compute-chiplet split (Lunar-Lake-style controller separation, or
  Apple-Ultra-style die fusion) reopens the board-package checklist with a
  new variant entry and a new packaging-evidence row.
- Do **not** carry CoWoS-class silicon-interposer packaging in E1
  planning -- it is out of mobile power and cost envelope.

## Medium-Confidence Recommendations (Plan, Gate On PDK)

### M1. Foundry-and-node candidate set should remain TSMC A14, Samsung SF1.4, Intel 14A, Rapidus 2 nm

Binding: `required_effects.node_identity_and_pdk_binding`.

Sources: `tsmc_a14_roadmap`, `samsung_foundry_sf2`, `intel_foundry_14a`,
`rapidus_2nm`.

Action:
- Keep `selected_process_option: blocked_until_foundry_pdk_and_library_selection`.
- Candidate set above is the credible 2028 mobile-class 14A-class node set
  by public roadmap status. No public statement justifies adding others.
- Carry the foundry candidate matrix in a separate planning document if
  more detail is needed; do not unblock the contract field by guess.

### M2. Hybrid bonding for logic-on-SRAM (SoIC-X-class) is a credible 2028 cache-stack option

Binding: `required_effects.sram_density_vmin_and_ecc` +
`docs/manufacturing/board-package-2028-scaling-checklist.yaml`.

Sources: `tsmc_soic`, `imec_hybrid_bond_pitch`, `sony_hybrid_bonding_ieice`.

Action:
- If a large E1 last-level cache is needed beyond what fits monolithically
  at A14-class, hybrid-bonded SRAM on top of the logic die (TSMC SoIC-X
  pattern at die-to-wafer 3--5 um pitch) is the credible 2028 path.
- Carry this as a planning variant; do not assert it without a packaging
  PDK + thermal model + yield/test plan.
- The thermal benefit comes from the SRAM die being cooler than the logic
  die; logic-on-logic hybrid bonding is NOT a thermal-credible option in
  a phone enclosure.

### M3. If chiplet is added, use UCIe Standard package mode (organic substrate or InFO_LSI bridge)

Binding: `docs/manufacturing/board-package-2028-scaling-checklist.yaml`.

Sources: `ucie_1_1_spec`, `ucie_2_0_announcement`, `bow_ocp_chiplet`,
`intel_lunar_lake`.

Action:
- UCIe Standard mode on organic substrate, or on an InFO_LSI / EMIB-style
  silicon bridge, is the credible mobile chiplet PHY.
- UCIe Advanced + silicon interposer is not mobile-power-envelope; do not
  carry it in E1 planning.
- BoW is acceptable as an alternative for cost-sensitive variants; AIB
  2.0 is legacy and is not a forward choice.

## Low-Confidence / Out-Of-Scope Items (Track, Do Not Adopt)

### L1. CFET (complementary FET) -- post-2028

Sources: `imec_cfet_2023`, `irds_2024_more_moore`.
Action: Track in research. Do not assume CFET in any E1 2028 PPA or
density claim. Re-open the contract if a foundry exposes CFET in PDK form
inside the E1 production window.

### L2. 2D-material channels (MoS2 / WSe2 / TMDs) -- research-stage

Sources: `2d_material_mosfet_iedm`.
Action: Track only. No foundry PDK exists for this in the 2028 window.

### L3. Forksheet -- research-stage transitional device

Sources: `imec_forksheet`.
Action: Not in E1 candidate set unless a foundry exposes it via PDK.

### L4. CoWoS-class silicon-interposer packaging for E1

Sources: `tsmc_cowos`.
Action: Out of mobile power and cost envelope. Do not include in E1
planning.

### L5. High-NA / hyper-NA EUV as an E1 evidence item

Sources: `asml_high_na_exe5000`, `asml_high_na_exe5200`, `irds_2024_lithography`.
Action: This is a foundry responsibility, surfaced via the PDK and yield
telemetry. Do not encode High-NA explicitly in E1 evidence beyond
`dft_yield_and_debug_lock`.

### L6. SoW (system on wafer) wafer-scale integration

Sources: `tsmc_sow`.
Action: HPC/datacenter target, not mobile. Out of scope.

## Cross-Reference Matrix

| required_effect ID                          | Recommendations using it      |
|---------------------------------------------|-------------------------------|
| node_identity_and_pdk_binding               | H2, H6, M1                    |
| nanosheet_device_variability                | H2, H3                        |
| frontside_vs_backside_power_delivery        | H1                            |
| interconnect_rc_and_congestion              | (analysis-only, no new gate)  |
| self_heating_and_power_density              | H5                            |
| sram_density_vmin_and_ecc                   | H4, M2                        |
| reliability_aging_and_lifetime              | H3                            |
| dft_yield_and_debug_lock                    | (foundry-side, L5)            |

## Items NOT Changed

- The `process-14a-effects.yaml` contract's release-gate is correct as
  written. Nothing in this packet authorizes a tapeout or PPA claim.
- The `selected_process_option` field stays
  `blocked_until_foundry_pdk_and_library_selection`. No public source in
  the inventory unblocks it.
- `claim_boundary` and `release_gate.forbidden_claims_until_complete` are
  unchanged.

## Where The Evidence Lives After This Packet

- This packet:
  `research/process_packaging_2026/` (planning evidence only).
- The work-order contract:
  `docs/spec-db/process-14a-effects.yaml`.
- PD signoff:
  `pd/signoff/manifest.yaml` and `pd/signoff/pdn-current/local-budget.yaml`.
- Manufacturing evidence:
  `docs/manufacturing/board-package-2028-scaling-checklist.yaml`,
  `docs/manufacturing/real-world-verification-gaps.yaml`,
  `docs/manufacturing/evidence/thermal/e1-npu-thermal-capture-plan.md`,
  `docs/manufacturing/product-feature-evidence-manifest.yaml`.
- Architecture:
  `docs/arch/memory-subsystem.md`, `docs/arch/npu-microarch.md`,
  `docs/architecture-optimization/physical-power-thermal.md`,
  `docs/architecture-optimization/phone-platform.md`.

Each high-confidence recommendation above names the bullet inside the
contract that it lives under. No edit to files outside this packet is
performed.
