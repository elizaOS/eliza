# Process Node SOTA — 2028 RISC-V Phone-Class AP

Sub-report of [2028-sota-integrated-report.md](../2028-sota-integrated-report.md).

## A. SOTA snapshot

The 2025-2028 leading-edge logic cohort consolidates four shifts: (1) FinFET → GAA / RibbonFET / MBCFET, (2) frontside → backside power delivery (PowerVia, Super Power Rail, SF2Z BSPDN), (3) NanoFlex / NanoFlex Pro DTCO cell mixing, (4) High-NA EUV adoption — only at Intel 14A; TSMC skips through A14.

| Node | Foundry | HVM | Transistor | BSPDN | High-NA | HD density (MTr/mm²) | HD SRAM bitcell (µm²) / density | Perf-or-power gain vs prior | Wafer (300 mm) | Lead customer |
|---|---|---|---|---|---|---|---|---|---|---|
| N3 / N3E / N3P | TSMC | 2022 / 2023 / 2H 2025 | FinFET | no | no | ~215-220 (N3E HD) | 0.021 (≈ N5) | N3P: ~5% perf or ~5-10% power vs N3E | ~$19.5-25 k | Apple A17/A18/A19, S8E Gen 4/5, D9400/9500, Tensor G5 |
| N2 | TSMC | 2H 2025 | GAA NanoSheet (NanoFlex) | no | no | **313 (HD)** | 0.021 (HD), 38.1 Mb/mm² macro | ~10-15% perf @ iso-power or ~25-30% power @ iso-perf vs N3E | ~$30 k | **Apple (>50% of initial N2)**; NVIDIA, AMD follow 2026-2027 |
| N2P | TSMC | 2H 2026 | GAA NanoSheet | no | no | ~313+ | same as N2 | Modest lift over N2 | ~$30-33 k | Apple A20-class 2026-2027, Qualcomm/MTK transition 2027 |
| A16 | TSMC | 2027 (slipped from 2H 2026) | GAA NanoSheet | yes (Super Power Rail) | no | ~1.07-1.10× N2P | minor | 8-10% perf @ iso-power or 15-20% power @ iso-perf, +7-10% density vs N2P | not public | HPC / AI first (NVIDIA), then mobile |
| A14 | TSMC | 2028 (ahead of plan) | 2nd-gen GAA (NanoFlex Pro) | A14 baseline frontside; A14P (SPR) 2029 | **no** (TSMC explicit) | >1.20× N2 logic | scaling resumed at N2 family | **+15% speed @ iso-power, or -30% power @ iso-speed, +20% logic density vs N2** | est. $40-45 k | Apple, NVIDIA, AMD; mobile mid-cycle 2028-2029 |
| A14P | TSMC | 2029 | 2nd-gen GAA + SPR BSPDN | yes | no | A14 + density gain | minor | additional perf @ iso-power over A14 baseline | est. $45 k+ | HPC, AI, then flagship mobile |
| A13 / N2U | TSMC | 2029 | optical shrink of A14 / DTCO refresh of N2 | inherits | no | ~+6% over A14 (A13) | minor | N2U: +3-4% perf or 8-10% power, +2-3% density | unpublished | cost-down follow-on |
| 18A | Intel | HVM Dec 2025 | RibbonFET GAA | **yes (PowerVia, 1st-gen)** | no | **238 (HD)** | competitive, less than N2 | PowerVia ~30% IR drop reduction, +6% Fmax, +5-10% std-cell utilisation vs frontside; ~10% perf / 25% power vs Intel 3 | private | Intel Panther Lake; foundry ramping |
| 18A-PT | Intel | 2026 | RibbonFET + 3D stacking | yes | no | similar | similar | enables Foveros / hybrid-bond stacking | private | Intel HPC, foundry |
| 14A | Intel | risk 2027, HVM 2028+ | RibbonFET 2nd gen | **yes, 2nd-gen PowerVia** | **yes — industry first** | not public; targets > N2/A16 | n/a | Intel claim: ~15-20% perf @ iso-power, ~25-30% power @ iso-perf vs 18A | private | DARPA, US gov, hyperscaler diversification |
| SF3 / SF3P | Samsung | 2022 / 2024 | GAA MBCFET (1st) | no | no | ~170-200 (est) | ~0.026 | yield issues; limited external uptake | lower than TSMC | Exynos 2400/2500, internal |
| SF2 / SF2P | Samsung | 2H 2025 / 2026 | GAA MBCFET (3rd) | no | no | **231 (HD)** | n/a public | +25% power efficiency @ iso-clock vs SF3P | competitive | **Exynos 2600 (Galaxy S26)**, Exynos 2800 on SF2P+ |
| SF2Z | Samsung | 2027 | GAA MBCFET + BSPDN | **yes** | no | density lift via BSPDN cell-height shrink | n/a | further IR / power | n/a | foundry play vs TSMC A16 |
| SF1.4 | Samsung | delayed 2028-2029, public 2029 | "Vertical-GAA" | inherits | optional | not public | n/a | de-prioritised for 2nm yield in 2025; slipped | n/a | Exynos late-2029 flagship at earliest |

Three SOTA observations:

1. **TSMC N2 HD density (313 MTr/mm²) is ahead of Intel 18A (238) and Samsung SF2 (231).** But Intel 18A delivers PowerVia ~12 months before TSMC's first BSPDN node (A16), so 18A's perf/W is closer to N2/N2P than density alone suggests.
2. **SRAM scaling stalled at N3** (0.021 µm² bitcell, ~5% over N5) and only resumed at N2 — 38.1 Mb/mm² macro using same 0.021 µm² HD bitcell with reorganised assist. Cache-heavy mobile designs that scale through N3 do not gain SRAM area unless they go to N2+.
3. **High-NA EUV is not on TSMC's path to A14.** TSMC stated repeatedly A14 ships without High-NA; Intel 14A is the only public node committing to High-NA, only in 2027-2028. Caps Intel-foundry capacity scaling on 14A in our 2028 window.

Reference 2025-class flagship dies:
- Apple **A19 Pro: 98.68 mm²**, P-core 2.97 mm² (5.49 mm² with L2+shared), E-core 0.78 mm² (2.22 mm² w/ L2), SLC 11.03 mm² — N3P.
- Apple **A19: ~81.9 mm²** on N3P.
- **Snapdragon 8 Elite Gen 5: ~126.2 mm²** on N3P.
- **Dimensity 9500**: N3P, 1+3+4 ARM cores at 4.21 / 3.5 / 2.7 GHz.

## B. Current state in `packages/chip`

- `pd/openlane/config.sky130.json` points at `sky130A` PDK, `sky130_fd_sc_hd`, met5, 2500 × 2500 µm die, 100 ns clock. Real, runnable on open tooling, but 130 nm — three-four generations below mobile flagship, ~six below 2028 target.
- `docs/spec-db/process-14a-effects.yaml` is a fail-closed planning contract: forbids any "14A tapeout ready" / "1.4 nm power/performance" / "Pixel-class 2028 efficiency" claim until `pd/signoff/manifest.yaml`, `benchmarks/power/workload-plan.yaml`, NanoSheet variability evidence, and frontside-vs-backside PDN tradeoffs are populated. Selected option `blocked_until_foundry_pdk_and_library_selection`.
- `research/alpha_chip_macro_placement/06_e1_notes/openlane_full_release_2026-05-19.md`: 3.24 mm² die, 142,274 std-cells, 0 macros, clean DRC/LVS, 23,099 max-slew + 442 max-cap + small hold-TNS violations. No real SRAM/CPU/NPU hard macros.
- `docs/spec-db/competitor-2028-target.md` sets envelope: 4-8 RV64GC Linux-capable cores, 16-24 GB LPDDR5X/6, 120-180 GB/s sustained, 16-32 MB SLC, 80 TOPS dense INT8 sustained / 160 TOPS peak, 64 MiB NPU SRAM.

Summary: Sky130 PD scaffold and complete claims-gate skeleton for a 14A target, but zero advanced-node access, zero qualified hard IP, zero LPDDR/USB/MIPI PHY, zero characterised SRAM macro at any target node, no Linux-capable RV64GC AP integrated (only the tiny CVA6 wrapper).

## C. Recommended target (2028)

### Primary: TSMC N2P (HVM 2H 2026, mobile-ready by 2028)

- N2P has broadest 2028 mobile customer surface — Apple A20 / A21, Qualcomm flagship after Elite Gen 5, MediaTek post-D9500. Tool/IP/PHY ecosystem co-evolves with these customers.
- HD density 313 MTr/mm² + 38.1 Mb/mm² SRAM — first node since N5 where SRAM scaling resumes. Mandatory for 64 MiB NPU SRAM + 16-32 MB SLC envelope.
- Frontside power delivery — debug, thermal modelling, DFM tractable. BSPDN tax (warpage during HPA, thermal coupling through thinned silicon, two-sided test access) is real and adds 6-12 months bring-up risk.
- Wafer ~$30-33 k/wafer is the cheapest 2 nm-class entry point.

### Stretch: TSMC A14 (HVM 2028, baseline frontside) or Intel 14A (HVM 2027-2028, BSPDN+High-NA)

A14 baseline (no SPR) delivers +15% perf @ iso-power or -30% power @ iso-perf vs N2 with +20% logic density, without the BSPDN tax. The realistic 2028-flagship sweet spot if the project has Apple/NVIDIA-tier wafer allocation and willing-to-pay $40-45k pricing. A14P (with SPR) variant pushes to 2029.

Intel 14A is a strategic second source — Intel courts non-Apple customers for foundry diversification and is the only path to 18A-class PowerVia BSPDN in our 2028 window if foundry-level subsidy or government program participation is available. Process unproven for mobile AP class; hard-IP ecosystem (LPDDR PHY, MIPI, USB) much thinner at 14A.

### Multi-process portability requirements

The PD flow must abstract PDK-specific assumptions into a single configuration surface:
- `pd/openlane/config.<node>.json` per target (sky130, gf180, ihp-sg13, asap7-predictive, n2p-stub, a14-stub).
- Per-node corner manifest: 5 PVT corners minimum at advanced node (SS/TT/FF × low/high V × extreme T) plus aging, EM, SI/IR; multi-Vt mix (LVT/SVT/HVT).
- Per-node hard-IP manifest: SRAM compiler version, LPDDR PHY version, USB / MIPI PHY versions, PLL/PMIC.
- Encapsulated cell-library swap so synthesis/place/route tooling differences (OpenLane → Cadence Innovus / Synopsys Fusion Compiler at advanced node) isolated to single adapter layer.

### Hard-IP partnerships (process-matched, non-negotiable)

| IP | 2028 requirement | Source |
|---|---|---|
| LPDDR5X / LPDDR6 PHY+ctrl | 9600-10667 Mbps, 64-bit | Synopsys DesignWare LPDDR5X (proven at 9600 on 3 nm; N2-ready), Cadence LPDDR6/5X (10.7 Gbps), Rambus |
| USB 3.2 / USB4 PHY | 20-40 Gbps | Synopsys / Cadence / Rambus |
| MIPI D-PHY v3.x + C-PHY v2.x + DSI-2 / CSI-2 | flagship cameras + display | Synopsys / Mixel / Lattice |
| PCIe Gen4/5 PHY | optional, NVMe | Synopsys / Cadence |
| Multi-port SRAM compiler | up to 32 MB SLC, 64 MiB NPU local | TSMC SRAM compiler at selected node (closed) |
| PLL / clock | multi-domain, low-jitter | Synopsys / Cadence |
| Analog (PMIC, ADC, temp, eFuse) | mobile-class | foundry reference + 3rd-party |

### Reticle / package / cost assumptions

- Monolithic die assumed at 2028 mobile. CoWoS-class 3D stacked SLC (Apple-style fused cache stack) is stretch and out of cost envelope for open project.
- Reticle limit at N2/A14 is ~858 mm² (26 × 33 mm) — well over a single mobile AP die.
- Mobile AP die-area budget: 90-130 mm² for flagship envelope.
  - At N2 density (313 MTr/mm² HD logic, ~38 Mb/mm² SRAM):
    - Big OoO RISC-V (A19-Pro P-core equivalent): 2.5-3.5 mm² each
    - Little IoT/efficiency: 0.6-1.0 mm² each
    - NPU: 4-6 mm² compute logic + 64 MiB local SRAM at ~1.7 mm²/MiB = ~110 mm² for SRAM alone if naively flat — forces NPU memory hierarchy (small dense SRAM 8 MiB local + connection to 16-24 MB SLC and LPDDR)
    - SLC: 8-12 mm² for 16-24 MB
    - LPDDR PHY: 6-10 mm² (PHY does not scale with logic)
    - GPU (Imagination or RISC-V SIMT): 6-10 mm²
    - Modem, ISP, codecs, AON: 6-12 mm² combined
- Mask + NRE: $40 M mask set at N2/A14 + design/verification/IP licensing → single-tapeout NRE **$250-400 M** for SoC-class, $542 M IBS-2018-style upper bound at 5 nm adjusted up for 2 nm. The economic blocker; only realistic vehicles are (a) hyperscaler/government anchor customer, (b) MPW shuttles (effectively closed at N2), or (c) partnership with existing high-volume customer.

## D. Benchmarks / evaluation / testing

What we can do today (no advanced-node PDK access):

1. **DTCO sensitivity at open nodes.** Same RTL through Sky130A, GF180MCU, IHP SG13G2 — confirms tooling portable. Already partly demonstrated.
2. **PPA modelling against ASAP7 predictive PDK.** ASAP7 is academic-only, not manufacturable, but only open PDK with FinFET-era device physics; gives credible relative PPA scaling. Run e1 CPU+NPU+SLC through ASAP7, apply vendor scaling factors (N5 → N3 → N2) to project N2P-class envelope. Document as projections, not signoff.
3. **Process-variation Monte Carlo at open nodes.** Sky130 has SS/TT/FF Liberty corners — characterise e1 RTL sensitivity to ±20% Vt shift and ±10% Vdd droop. Shapes translate to advanced nodes.
4. **Die-shot calibration.** Compare projected block-area vs published die-shots (TechInsights, Locuza, Cardyak A19 Pro, AnandTech archive). A19 Pro P-core ≈ 2.97 mm² logic in N3P → at N2 density (313 / ~215 = ~1.45×) ≈ 2.04 mm²; RV64GC OoO with vector should land 2.5-3.5 mm² depending on issue width and L2.
5. **Multi-PDK signoff matrix.** Sign off same RTL under Sky130A (open), GF180MCU (via Wafer.Space), IHP SG13G2 (Tiny Tapeout 2025/26 shuttle), ASAP7 (predictive). Shows physical-design discipline across PDKs before advanced-node access.
6. **Block-level evidence gates.** Per block (CPU big, NPU, SLC, LPDDR PHY interface, MIPI), produce per-block PPA target with `pd/signoff/manifest.yaml` schema. Track four numbers: max-freq, area, dynamic-power-per-MHz, static leakage.

What we cannot do without commercial PDK:
- Real signoff timing under foundry corners.
- Real LPDDR / USB / MIPI / PCIe PHY layout.
- DFM / antenna / fill at 2 nm.
- BSPDN-aware PDN / IR analysis.

## E. Optimisations: has / should / needs

### Has
- OpenLane Sky130A end-to-end flow, clean DRC / LVS at 130 nm, runnable release-mode.
- Fail-closed claim gates: `process-14a-effects.yaml`, `competitor-2028-target.md`, `pd/signoff/run-manifest.schema.json`, OpenLane release-baseline doc — prevent unjustified 2028-class claims.
- Minimal RV32 e1 datapath + AXI-lite interconnect + MMIO NPU + bootrom + interrupt controller + DMA.

### Should (next 6-12 months, no advanced-node spend)
1. CVA6 (or BOOM / XiangShan) integrated as actual application core in OpenLane release flow — not wrapper. Linux boot on QEMU/Renode/FireSim.
2. ASAP7 predictive sign-off of CPU big core, NPU compute tile, small SLC slice.
3. Real SRAM macros integrated into OpenLane — currently 0 macros. OpenRAM Sky130 → move same RTL to GF180/IHP for sanity.
4. Multi-corner signoff manifest per existing `pd/signoff/run-manifest.schema.json` — populate SS/TT/FF corners with real Liberty data.
5. NoC + IOMMU + cache-coherent fabric RTL — RTL-layer work not needing advanced PDK.
6. NanoFlex-Pro-style cell-mix DTCO study. Sky130 has HD/HS variants (`hd`, `hs`, `hdll`, `ms`). Same block with cell swaps to characterise design-time tradeoffs NanoFlex Pro automates at N2/A14.

### Definitely needs (foundry-wall items)
- Foundry PDK access at N2P or A14. Realistic paths: CHIPS Act / DARPA programme (Intel 18A/14A has DARPA/RAMP-C subsidy for non-traditional customers); customer-of-record under hyperscaler or major IP vendor; multi-project shuttle at N5/N3 first (Efabless is closed; very few alternatives), then private MPW at N2.
- Qualified hard IP for selected node: LPDDR5X/6 PHY, USB, MIPI, PLL, SerDes. Process-matched and re-licensed per shrink.
- 5+ PVT signoff corners + multi-Vt cell mix.
- BSPDN-aware sign-off methodology if A16 / A14P / 18A / 14A — adds two-sided power-grid extraction, thermal-coupling models for thinned silicon, two-sided DFM rules.
- DFM, reliability (BTI, HCI, TDDB, EM), aging derate, scan/MBIST/boundary-scan, fuse policy, secure-debug lock — all enumerated in `process-14a-effects.yaml`; all require PDK.
- Real package & PCB stackup model — FCBGA mobile substrate + thinned ~100 µm die, full thermal path (TIM, mid-plate, frame, skin), measured-not-modelled correlation.

## F. Risks and open questions

1. **Foundry access is binary risk.** TSMC N2 booked through 2027-Q2 with Apple holding >50% of initial wafers. Open RISC-V has no leverage at TSMC outside major customer relationship. Intel Foundry more open to non-Apple but unproven at mobile AP class.
2. **NRE economics.** $250-400 M single N2/N2P tapeout, possibly $300-500 M at A14. Open-source funding models don't reach this scale.
3. **EUV / High-NA scarcity.** Only ASML ships High-NA scanners; first units reserved for Intel and TSMC. Even if 14A nominally accessible, scanner-allocation isn't.
4. **BSPDN test/debug.** Two-sided power changes probe/test access; boundary-scan, thermal-IR camera methods, rework all need new methodology. Multi-quarter learning curve even with PDK in hand.
5. **Hard-IP-availability-vs-node coupling.** Synopsys LPDDR5X PHY shown at 3 nm and N2; LPDDR6 at N2P/A14 appears in vendor plans, but not all combinations are available. A project picking A14 in 2028 may be PHY-limited even with logic PDK.
6. **SRAM density realism.** N3-family SRAM did not scale (bitcell 0.021 µm² ≈ N5). N2 resumes via macro-level density (38.1 Mb/mm²), not bitcell shrink, requiring redesigned assist circuitry. Cache/NPU-SRAM area estimate at N2P/A14 must use macro density, not bitcell shrink, or will under-budget area by 10-20%.
7. **Yield + defect-density curves.** D0 at new 2 nm-class node in early ramp ~0.20-0.30/cm²; improves slowly. 100-130 mm² mobile AP die at D0 = 0.25 has yield 55-65% during 2025-2027 ramp.
8. **Open-silicon pipeline ends at Sky130/GF180/IHP SG13.** 130 nm open-PDK frontier was real achievement. Not moving up the node ladder fast enough — Efabless shut down March 2025, taking ChipIgnite shuttle. Tiny Tapeout migrating onto IHP SG13G2 (130 nm) via SwissChips. ASAP7 exists as predictive academic PDK but not manufacturable. No path from open PDKs to flagship-class mobile AP that does not go through commercial foundry NDA.
9. **Software / Android side.** Even with silicon, open RISC-V Android AP needs full CTS/GMS pass, kernel BSP, vendor HAL, GPU driver (open Mali / IMG / RISC-V SIMT), camera HAL, modem integration.

### Recommended next decision

**TSMC N2P primary**, **TSMC A14 stretch**, **Intel 14A strategic second-source / subsidy-driven option**. Update `docs/spec-db/process-14a-effects.yaml`:
- `marketing_name` becomes a range: "N2P / A14 / 14A class".
- `selected_process_option` adds per-node short list with three nodes.
- `node_target.transistor_architecture` stays `nanosheet_or_successor_gate_all_around_required`.
- `power_delivery_variant` keeps frontside-vs-BSPDN bifurcation; default is frontside (matching N2P / A14-baseline) rather than implying BSPDN.

## Sources

- Tom's Hardware: TSMC process-node plan through 2029 — A12, A13, N2U; A16 to 2027
- [TSMC Tech Symposium 2025](https://semiengineering.com/tsmc-tech-symposium-2025/)
- [TSMC unveils 1.4 nm A14 — 2nd-gen GAA, 2028](https://www.tomshardware.com/tech-industry/tsmc-unveils-1-4nm-technology-2nd-gen-gaa-transistors-full-node-advantages-coming-in-2028)
- [TSMC A14 process announcement (TSMC ESG)](https://esg.tsmc.com/en-US/articles/366)
- [TSMC reiterates no High-NA EUV for A14](https://www.tomshardware.com/tech-industry/semiconductors/tsmc-reiterates-it-doesnt-need-high-na-euv-for-1-4nm-class-process-technology)
- [Intel 18A vs TSMC N2 density](https://www.tomshardware.com/tech-industry/intels-18a-and-tsmcs-n2-process-nodes-compared-intel-is-faster-but-tsmc-is-denser)
- [Intel 18A HVM Dec 2025](https://business.thepilotnews.com/thepilotnews/article/tokenring-2025-12-29-intel-reclaims-the-silicon-throne-18a-process-enters-high-volume-manufacturing)
- Tom's Hardware: Intel Foundry process-node update — 18A-PT, 14A
- Tom's Hardware: Samsung SF2 / SF2Z process-node plan
- [Samsung SF1.4 delayed to 2028-2029](https://www.design-reuse.com/news/202528931-samsung-reportedly-prioritizes-2nm-4nm-improvements-with-1-4nm-unlikely-before-2028-29/)
- [TSMC 2 nm 38.1 Mb/mm² SRAM (TSMC Research)](https://research.tsmc.com/page/memory/4.html)
- [N3 SRAM scaling stall — WikiChip](https://fuse.wikichip.org/news/7048/n3e-replaces-n3-comes-in-many-flavors/)
- [TSMC N2 wafer price $30k](https://technode.com/2025/10/09/tsmc-sets-2nm-wafer-price-at-30000-far-below-earlier-50-increase-speculation/)
- [TSMC A16 wafer price ~$45k speculation](https://www.tomshardware.com/tech-industry/semiconductors/tsmc-could-charge-up-to-usd45-000-for-1-6nm-wafers-rumors-allege-a-50-percent-increase-in-pricing-over-prior-gen-wafers)
- [Apple secures >50% of TSMC N2 capacity](https://wccftech.com/apple-secured-nearly-half-of-tsmc-2nm-wafer-supply-production-beginning-in-q4-2025/)
- [Backside power delivery (SemiEngineering)](https://semiengineering.com/backside-power-delivery-creates-fab-tool-thermal-dissipation-barriers/)
- [Apple A19 Pro die-shot 98.68 mm² (TechPowerUp)](https://www.techpowerup.com/344025/apple-a19-pro-a19-die-size-analysis-indicates-9-10-smaller-than-a18-models)
- [Snapdragon 8 Elite Gen 5 die-shot (Notebookcheck)](https://www.notebookcheck.net/Snapdragon-8-Elite-Gen-5-die-shot-highlights-minor-upgrades-and-GPU-improvements.1124373.0.html)
- [Mask cost dynamics (SemiAnalysis)](https://newsletter.semianalysis.com/p/the-dark-side-of-the-semiconductor)
- [3 nm/2 nm chip cost projection (PatentPC)](https://patentpc.com/blog/chip-manufacturing-costs-in-2025-2030-how-much-does-it-cost-to-make-a-3nm-chip)
- [Synopsys LPDDR5X PHY at 9.6 Gbps on 3 nm](https://www.synopsys.com/designware-ip/interface-ip/ddr/lpddr5x54x-phy.html)
- [Cadence LPDDR6/5X IP at 10.7 Gbps](https://www.cadence.com/en_US/home/tools/silicon-solutions/protocol-ip/memory-interface-and-storage-ip/lpddr-phy-and-controller/lpddr6-lpddr5-lpddr4x-lpddr4-lpddr3-phy-controller.html)
- [Efabless shutdown + Tiny Tapeout migration to IHP SG13G2](https://www.eenewseurope.com/en/tiny-tapeout-sees-industrial-boost-as-it-recovers-from-efabless-closure/)
- [ASAP7 predictive PDK on GitHub](https://theopenroadproject.org/news/openroad-releases-asap7-7nm-predictive-pdk-on-github/)
- [SiFive 5 nm RISC-V proof](https://www.sifive.com/blog/sifive-risc-v-proven-in-5nm-silicon)
