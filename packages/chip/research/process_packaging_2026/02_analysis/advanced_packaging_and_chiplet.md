# Advanced Packaging, 3D Stacking, Hybrid Bonding, And Chiplet Interconnect

Date: 2026-05-19

Scope: foundry and OSAT advanced packaging options relevant to a 2028
mobile-class SoC, hybrid-bonding pitch trajectory, and the chiplet-
interconnect-standard landscape (UCIe 1.1/2.0, BoW, OpenHBI, AIB 2.0).
Mobile-chiplet evidence is reviewed to decide whether a chiplet partition
is appropriate for E1's product window.

Sources: `tsmc_cowos`, `tsmc_info`, `tsmc_soic`, `tsmc_sow`, `intel_foveros`,
`intel_emib`, `samsung_xcube`, `samsung_icube`, `ase_vipack`, `amkor_swift`,
`sony_hybrid_bonding_ieice`, `imec_hybrid_bond_pitch`, `irds_2024_packaging`,
`ucie_1_1_spec`, `ucie_2_0_announcement`, `openhbi_oif`, `bow_ocp_chiplet`,
`aib_2_0`, `intel_lunar_lake`, `snapdragon_x_elite`, `apple_m_ultra_fusion`.

## Foundry / OSAT Packaging Family Overview

### TSMC

- **CoWoS** (`tsmc_cowos`): silicon-interposer (CoWoS-S), RDL-interposer
  (CoWoS-R), and LSI-bridge interposer (CoWoS-L) variants. Production
  vehicle for NVIDIA H100/B100/B200/GB200, AMD MI300, Google TPU v5/v6,
  AWS Trainium 2. Interposer area extending past 3.3x reticle on
  2025--2026 vendor plan. Cost and supply have been industry bottlenecks.
- **InFO** (`tsmc_info`): InFO_oS for fan-out on substrate (Apple M-series),
  InFO_LSI for bridges (Apple UltraFusion), InFO-R for RDL fan-out at
  finer pitch. Mobile-class economics.
- **SoIC** (`tsmc_soic`): copper-to-copper hybrid bonding. SoIC-X / SoIC-P
  family. Pitches reported at 9 um and scaling toward 3--4 um for
  next-generation production. Used in AMD V-Cache (logic-on-SRAM stacking).
- **SoW** (`tsmc_sow`): wafer-scale integration via reticle stitching;
  presented as the path beyond CoWoS reticle-area limits.

### Intel

- **EMIB / EMIB-T** (`intel_emib`): embedded multi-die interconnect bridge
  inside organic substrate; EMIB-T adds TSV for power + signal through the
  bridge. Used in Sapphire Rapids, Ponte Vecchio, Granite Rapids.
- **Foveros** (`intel_foveros`): face-to-face stacking via microbump (legacy)
  or copper hybrid bonding (Foveros Direct). Used in Meteor Lake, Lunar
  Lake, Arrow Lake. Foveros Direct pitches sub-10 um.

### Samsung

- **X-Cube** (`samsung_xcube`): hybrid-bonded 3D IC stack with sub-10 um
  pitch. Targets HPC/AI / HBM stacking.
- **I-Cube** (`samsung_icube`): silicon interposer (I-Cube-S) and embedded
  interposer (I-Cube-E) for HBM + logic packaging.

### OSAT (Outsourced Assembly And Test)

- ASE VIPack (`ase_vipack`): fan-out, bridge, 3D stack offerings targeting
  mid-range AI and chiplet platforms.
- Amkor SWIFT / S-SWIFT (`amkor_swift`): bridge-based and silicon-less RDL
  for AI / HPC.

OSAT options matter because foundry-side advanced packaging capacity
(especially CoWoS) is constrained; mid-range AI products at A14-class will
often need OSAT-side packaging.

## Hybrid-Bonding Pitch Trajectory

`sony_hybrid_bonding_ieice`, `imec_hybrid_bond_pitch`, `irds_2024_packaging`:

- Sony image-sensor wafer-to-wafer hybrid bonding has been at sub-1 um pitch
  for years and is the reference point for sub-1 um feasibility.
- Logic wafer-to-wafer hybrid bonding trajectory:
  - 2024: 1 um pitch in pilot.
  - 2026--2027: ~700 nm pitch in production.
  - 2028: ~400--500 nm in pilot.
- Die-to-wafer hybrid bonding (more relevant for chiplet integration):
  - 2024: 5--9 um pitch in production (TSMC SoIC).
  - 2026: ~3--5 um pitch entering production.
  - 2028: sub-3 um in pilot lines.
- Yield, overlay, alignment, and particle control are the gating issues.

For E1 at 2028: die-to-wafer ~3--5 um hybrid bonding is the credible
planning assumption. Sub-1 um logic-on-logic is **not** credible for a 2028
mobile production target.

## Thermal Challenges In 3D Stacks

`irds_2024_packaging`:

- Stacking a hot die under another hot die forces heat to travel through
  the upper die's BEOL + TSV stack before reaching the package heatsink.
- For a mobile package with no heatsink (only vapor chamber / chassis),
  the thermal-resistance budget of a 3D logic-on-logic stack is fundamentally
  worse than a 2D side-by-side chiplet arrangement.
- Logic-on-SRAM stacks (TSMC SoIC AMD V-Cache pattern) are thermally
  favorable because the SRAM die has lower power density and acts more like
  a thermal-transparent layer.
- For E1: a 3D logic-on-logic stack is not the right default. Logic + memory
  (LPDDR-on-package via InFO, or logic-on-SRAM via SoIC) is the credible
  3D direction.

## Chiplet-Interconnect Standard Landscape

### UCIe 1.1 / 2.0

`ucie_1_1_spec`, `ucie_2_0_announcement`:

- UCIe 1.1 defines two modes:
  - **Standard package**: targets organic-substrate chiplet packages, 16
    GT/s and up; aligns with EMIB-class / RDL-interposer use cases.
  - **Advanced package**: targets silicon-interposer or hybrid-bonded
    packages, up to 32 GT/s and beyond; bump pitches in the sub-25 um
    range.
- UCIe 2.0 (`ucie_2_0_announcement`): adds 3D-packaging hooks,
  manageability, and higher signaling rates.
- Protocol layer supports PCIe, CXL, and a streaming raw mode.
- UCIe is the de facto industry default for new chiplet products from
  2025 onward.

### BoW (Bunch of Wires)

`bow_ocp_chiplet`:

- OCP Open Domain Specific Architecture (ODSA) royalty-free chiplet PHY.
- Targets organic-substrate packages.
- Lower-cost alternative to UCIe Advanced; competes with UCIe Standard for
  mid-range chiplet products.

### OpenHBI

`openhbi_oif`:

- HBM-style memory-chiplet interface.
- Targets bandwidth-dense memory chiplets sharing a substrate with logic.
- Less relevant for logic--logic chiplet PHYs.

### AIB 2.0

`aib_2_0`:

- Intel-originated, CHIPS Alliance / DARPA-funded open chiplet
  interconnect.
- Foundation for early EMIB-class chiplet products.
- Largely superseded by UCIe for greenfield designs.

## Mobile Chiplet Evidence

`intel_lunar_lake`, `snapdragon_x_elite`, `apple_m_ultra_fusion`:

- **Intel Lunar Lake** (`intel_lunar_lake`): compute tile on TSMC N3B,
  platform-controller tile, packaged on Intel Foveros. Memory-on-package
  LPDDR5X. High-volume mobile chiplet product. Notable: monolithic +
  package memory pattern, not a logic-logic chiplet split.
- **Apple UltraFusion** (`apple_m_ultra_fusion`): silicon-interposer link
  between two M-Max dies; ~2.5 TB/s D2D bandwidth. Derived from mobile
  silicon but shipped in desktop Ultra products.
- **Qualcomm Snapdragon X Elite** (`snapdragon_x_elite`): monolithic die
  at N4P. Demonstrates that, even at laptop power envelopes, monolithic
  remains competitive at N4P; the chiplet decision is gated by economics
  (yield-on-large-die vs assembly cost) and reticle limit, not by raw
  technology availability.

The pattern across all three:

- Mobile-class chiplet **does** exist but it has been adopted primarily
  for memory-on-package or platform-controller separation, not for
  splitting compute itself across multiple dies.
- The compute die is monolithic when the reticle and yield allow.
- Where compute is split (Apple Ultra, GB200, MI300), the products are not
  phone-class power envelopes; they accept the additional packaging power
  and area cost.

## Implications For E1

E1 is a 2028 mobile-class SoC at A14-class. The packaging-evidence position
should follow public-product evidence rather than chasing the chiplet
narrative:

1. **Default to monolithic + package memory.** Memory-on-package (LPDDR5X
   today, LPDDR6 as JEDEC ratifies it via `jedec_lpddr5x_lpddr6`) is the
   credible mobile pattern. This binds to
   `docs/manufacturing/board-package-2028-scaling-checklist.yaml`.
2. **Treat chiplet partitioning as a follow-on variant**, not as a 2028
   base assumption. If reticle / yield economics force a split, the most
   credible split is platform-controller / IO separation (Lunar Lake
   pattern) on Foveros / InFO_oS / InFO_LSI, not compute--compute split.
3. **If chiplet is added**, use UCIe Standard mode on an organic-substrate
   or InFO_LSI bridge. UCIe Advanced + silicon interposer is out of
   mobile-power envelope.
4. **Hybrid bonding** at 2028 is credible for logic-on-SRAM cache (SoIC-X
   AMD V-Cache pattern) at die-to-wafer 3--5 um pitch. It is **not**
   credible for 3D logic-on-logic in a phone-class thermal envelope.
5. **CoWoS** is out of scope for E1's mobile target -- it is a HPC/AI
   datacenter packaging family.

These align with the existing
`docs/manufacturing/board-package-2028-scaling-checklist.yaml`. Any chiplet
or 3D-stack variant must reopen that checklist and add evidence under
`process-14a-effects.yaml: node_identity_and_pdk_binding` and
`dft_yield_and_debug_lock`.
