# Physical Design SOTA — 2028 RISC-V Phone-Class AP

Sub-report of [2028-sota-integrated-report.md](../2028-sota-integrated-report.md).

## A. SOTA snapshot

### A.1 PD flow stages and tool maturity matrix

| Stage | Open (OpenROAD/Yosys/KLayout/Magic) | Commercial (Cadence) | Commercial (Synopsys) | Sub-5 nm production? |
|---|---|---|---|---|
| RTL synth | Yosys + ABC | Genus | Fusion Compiler / DC NXT | Open: no; Commercial: yes |
| Floorplan / macro placement | OpenROAD `gpl`, `ppl`, `mpl` | Innovus | Fusion Compiler | Open: research-only <12 nm; Commercial: yes |
| ML macro placement | DREAMPlace 4.0, AlphaChip (circuit_training), ChiPFormer | Cerebrus AI Studio | DSO.ai | Commercial: yes, production; Open: experimental |
| Power planning / PDN | OpenROAD `pdn` | Innovus PDN + Voltus | Fusion Compiler + PrimePower / RedHawk-SC | Open: usable through ~12 nm; Commercial: yes incl BSPDN |
| Detailed placement | OpenROAD `dpl`, `dpo` | Innovus | Fusion Compiler | Open: ASAP7 demos only; Commercial: yes |
| CTS | OpenROAD `cts` (TritonCTS) | Cadence CCOpt | ICC2 CTS + ClockMesh | Open: H-tree only, no concurrent opt; Commercial: yes |
| Global / detailed route | OpenROAD `grt` + `drt` (TritonRoute) | NanoRoute (Innovus) | Zroute (Fusion Compiler) | Open: ~7 nm research; Commercial: yes |
| Parasitic extraction | OpenROAD `rcx` | Quantus | StarRC | Open: <7 nm not certified; Commercial: yes |
| STA signoff | OpenROAD `sta` (OpenSTA) | Tempus | PrimeTime / PrimeTime SI | Open: AOCV only, no POCV/SOCV/LVF; Commercial: full POCV+LVF |
| Power / IR signoff | OpenROAD `psm` (analytic) | Voltus | RedHawk-SC + PrimePower | Open: rail analysis only; Commercial: dynamic+EMIR+EM |
| Physical signoff (DRC/LVS/antenna) | KLayout, Magic, Netgen | Pegasus | IC Validator | Open: Sky130 / GF180 / IHP SG13 only; Commercial: all foundry |
| DFM / litho | (none) | Pegasus DFM, Litho Physical Analyzer | IC Validator + Proteus | Open: nothing serious; Commercial: yes |

### A.2 OpenROAD's actual frontier (2026)

- **Tapeouts**: ~600 logged, all Sky130 / GF180 via Efabless / ChipIgnite. Zero open-flow flagship-mobile signoff on any sub-7 nm published.
- **Largest open ASAP7 demos**: research-scale RISC-V cores; DARPA-funded "OpenROAD 7 nm Design Contest" produced sub-mm² blocks at 5 GHz under ideal-PDK. ASAP7 is predictive, not fabbable.
- **GF12 / Intel16 / TSMC65** platforms exist in ORFS source but PDK + LEF/LIB are NDA-gated.
- **Largest published open-flow Linux-capable SoC**: **Basilisk** (ETH Zurich PULP, 2024) — 64-bit RV64GC + HyperRAM, IHP SG13G2 130 nm, 1.1 MGE cell area, **77 MHz peak** (2.3× over predecessor Iguana), die area reduced 12%, fully Yosys+OpenROAD. High-water mark for "fully open EDA + Linux RISC-V SoC", at 130 nm running ~1/40 of phone-class clock.

### A.3 AlphaChip / Cerebrus / DSO.ai

- **AlphaChip (DeepMind, Nature 2021 + 2024 addendum)**: distributed RL, edge-graph CNN policy, proxy cost = α·wirelength + β·congestion + γ·density. Pre-trained checkpoint trained on 20 TPU blocks. Production for TPU v4 / v5e / Trillium / Axion. Hours instead of weeks for floorplanning. Published methodology controversy ("False Dawn" + arXiv 2302.11014) means proxy-cost wins are not automatically PPA wins.
- **Cadence Cerebrus AI Studio**: Samsung 8% power reduction in days; Renesas >10% perf; 5 nm mobile CPU +420 MHz with reduced leakage and total power; Imagination 5 nm GPU: 20% leakage / 6% total power. >1,000 tapeouts cumulative, ~50 new customers Q1 2025.
- **Synopsys DSO.ai**: 100 commercial tapeouts by Feb 2023. STMicro 3× productivity; SK hynix up to 5% die-size reduction at advanced nodes; up to 25% lower total power. Certified Samsung SF2 GAA (2 nm) June 2024.
- **DREAMPlace 4.0** (NVIDIA Research): GPU-accelerated analytic placer with timing-driven net weighting, 30× faster than multi-threaded CPU placers on global placement / legalization.

### A.4 BSPDN / PowerVia / backside power impact

- **Intel 18A PowerVia**: cell utilization +5-10%, iso-power perf +4%, op-freq +6%, power loss -30%.
- **Intel 14A**: 2nd-gen RibbonFET + 2nd-gen BSPDN ("PowerDirect"), Turbo Cells (double-height, high-drive variants).
- **TSMC**: N2 (2H 2025 HVM) and N2P (2H 2026 HVM) without BSPDN; A16 (2H 2026) introduces TSMC Super Power Rail. elizaOS "A14 / N2P target" must decide: N2P (no BSPDN, easier PD) or A16 (BSPDN, ~17% die-size reduction reported on Samsung-equivalent SF2 BSPDN, but PD complexity step-up).
- **PPA delta**: imec DTCO + Samsung disclosures: BSPDN → 8% perf, 15% power, ~17-19% HP-cell area reduction; IR-drop drastically improved.

### A.5 Signoff corners at N3 / N2

- Sub-65 nm: AOCV with logic depth + distance derate
- 20-16 nm: POCV mandatory in mainstream signoff
- <16 nm: SOCV / LVF and/or Moments-based variation
- **Corner count at N3/N2**: 100-200+ when crossing PVT × Vt × RC × modes × functional/scan/burn-in. Basic "16 corner" digital flows obsolete at <7 nm. ML-driven corner-pruning (ICCAD'23/24 "missing-corner prediction") can reduce count 50-70% with <5% error.

### A.6 Chiplet / 3D-IC trends

- CoWoS / EMIB / FOCoS-CL dominate HPC; InFO-LSI / InFO_oS dominate mobile. FoPLP emerging for cost but panel warpage and >10 µm RDL line widths — not bleeding-edge mobile.
- **Thermal**: 2.5D interposer hotspots >120 °C at 600-700 W board power for HPC. Mobile much lower power, but stacked DRAM-on-SoC adds 5-15 °C ΔT and forces PD to consider top-die TSV keepouts.

## B. Current state in `packages/chip`

### B.1 OpenLane Sky130 release run (RUN_2026-05-19_05-08-54)

From `research/alpha_chip_macro_placement/06_e1_notes/openlane_full_release_2026-05-19.md` and `pd/openlane/config.sky130.json`:

- DIE 2500 × 2500 µm = 6.25 mm² Sky130; CORE 2300 × 2300; FP_CORE_UTIL 20 → realized 0.265, instances 142,274, 0 macros, routed wire 3.64 M, vias 512,910.
- DRC: TritonRoute 0, Magic 0, KLayout 0. LVS: 0. Setup WNS +70.65 (slack positive at 10 MHz target), Hold WNS -0.109 ns, Hold TNS -0.144 ns.
- Slew violations 23,099, max-cap 442.
- Manifest schema (`pd/signoff/run-manifest.schema.json`) requires: corners[] (named LIB+RC), gds, def, gate_netlist, corner_manifest, sdc, spef, sdf, tool_versions; gates each of: drc / lvs / antenna / sta / utilization / congestion / density_fill with `status ∈ {clean, waived, blocked}`. Sound; does not yet require dynamic IR-drop, EM, or signoff-power evidence — gap for 2028.

Reading: standard-cell preflight, not signoff-grade. 100 ns clock means closure is irrelevant for performance. Zero hard macros means AlphaChip has no surface on this netlist.

### B.2 AlphaChip research and infra

- 10 source notes under `01_sources/` (ai_for_chip_design_sota, google_circuit_training, tilos_macroplacement, openroad_openlane_validation, +6 inventory YAMLs).
- Scripts under `scripts/alphachip/`: build_container, build_cuda_runtime_image, prepare_e1_softmacro_benchmark, make_soft_macro_benchmark, run_e1_softmacro_training, run_toy_training, evaluate_plc, compare_proxy_costs, run_coordinate_descent, package_nebius_payload, run_h200_payload, nebius_h200_runbook.
- **AlphaChip ↔ E1 benchmarks**:
  - Smoke (16 soft macros): OpenROAD proxy 0.499; first AlphaChip 0.761 — worse.
  - Full (256 soft macros, 16×16, 131,175 std cells): OpenROAD baseline 0.2379; Circuit Training coordinate-descent (not PPO RL) 0.2308 = **3.01% proxy-cost win**, mostly congestion + density, slight wire-length regression. PPO RL blocked on local NVIDIA runtime; Nebius H200 path staged.
- Nebius H200 runbook concrete: `USE_GPU=True NUM_COLLECT_JOBS=8 SEQUENCE_LENGTH=257 OBS_MAX_NUM_NODES=512 OBS_MAX_NUM_EDGES=8192 OBS_MAX_GRID_SIZE=16` matches upstream AlphaChip Ariane scaled to e1.

### B.3 What is NOT in the repo

- No characterized library at any advanced node.
- No commercial-tool footprint (no Innovus / Tempus / Voltus / Fusion Compiler / PrimeTime / RedHawk-SC / Calibre / IC Validator).
- No multi-corner STA evidence; OpenSTA inside OpenLane is single-corner.
- No CTS beyond TritonCTS H-tree; no CCOpt / mesh.
- No IO/PHY hard-IP: no DDR/LPDDR/USB/MIPI/PCIe PHY, no clocking PLLs as hard IP, no SRAM compiler beyond Sky130 OpenRAM-class.
- No DFT/scan/ATPG (only research notes in `ai_for_chip_design_sota.md` referencing Fault / OpenROAD-DFT).
- No DFM, antenna at advanced node, fill rules beyond Sky130 defaults.
- No UPF / multi-power-domain flow.

`physical-power-thermal.md`: "OpenLane/OpenROAD runs are useful only when the exact run directory, tool image, PDK, corners, constraints, and reports are archived. Preflight success is not PD closure." Consistent with audit.

## C. Recommended target (2028)

### C.1 Stage 1 — now → end of 2026: open-flow proof on free PDKs

- Pick one realistic-physics open PDK: prioritize **IHP SG13G2 (130 nm BiCMOS, fully open including DRC decks and Linux-capable demo silicon via Basilisk)** as Linux-capable demonstrator track. Continue Sky130 as fastest iteration.
- Add **real hard macros** to e1 floorplan: SRAM compiler outputs (OpenRAM for Sky130, IHP SRAM for SG13), PLL hard IP, IO ring. Without macros, AlphaChip is a non-tool.
- Achieve **AlphaChip-vs-OpenROAD** proxy + post-route PPA on a representative big-core / NPU floorplan with ≥16 hard macros. Extend `compare_proxy_costs.sh` to ingest post-route wirelength, congestion, IR-drop, routed timing slack — not just proxy.
- Lock in OpenROAD AutoTuner (Optuna/Nevergrad) around utilization, target density, CTS skew, route layer max, repair thresholds — highest-leverage near-term win.

### C.2 Stage 2 — 2026 → mid-2027: foundry path + tool partnership

- **Decide foundry**: TSMC vs Samsung vs Intel Foundry. For 2028 phone-class SoC with flagship target, realistic shortlist is TSMC N3P → N2 / N2P (mature 2H 2026 HVM) or Intel 18A (HVM 2H 2025). Intel 14A and TSMC A16 (BSPDN) are HVM 2026-2027; tapeout windows for 2028 phones close 2027-early-2028. Stretch: A16/14A; safe: N3P or N2.
- **EDA partnership** — without commercial Innovus/Tempus/Voltus or Fusion Compiler/PrimeTime/RedHawk-SC + Calibre/IC Validator + StarRC/Quantus, N2/N3 closure is unreachable. University programs (Synopsys University, Cadence Academic Network) ship academic licenses that won't sign off production. Real path: vendor commercial deal, foundry-funded shuttle, university partnership. Cost > $5M/year for full N2-class digital signoff.
- **Library characterization** budget: at N2 the Liberty LVF + RC corner matrix needs ≥120 corners. Liberate (Cadence) or PrimeLib (Synopsys) characterization farm or foundry-supplied IP libs end-to-end.
- **Multi-Vt strategy**: at least 3 Vt families (HVT/RVT/LVT/uLVT subset), Power-domain UPF flow with header/footer cells, AON-domain partitioning.

### C.3 Stage 3 — 2027 → 2028: full N2P / 14A signoff

- Multi-mode multi-corner (MMMC) STA across 16-32 dominant corners, with ML-based corner-pruning to manage the ≥100 corner total.
- POCV / SOCV with LVF mandatory (POCV mainstream <16 nm, SOCV / LVF at 5/3/2 nm).
- **CTS**: replace TritonCTS H-tree with **CCOpt** (Cadence) or **ICC2 ClockMesh+ConcurrentClockData** (Synopsys); for >GHz domains a partial mesh + leaf H-tree hybrid is de-facto N3/N2 pattern.
- **PDN + EMIR**: full Voltus or RedHawk-SC dynamic IR-drop signoff against workload activity vectors.
- **DFM**: Pegasus DFM / IC Validator + Proteus litho hotspots; foundry-mandated metal density / antenna / via-fill rules.
- **BSPDN-aware floorplan** (if A16 / 14A): plan for separate frontside-signal-only metal stack; less PDN drop, freed M0/M1 pitch, new TSV/nano-TSV keepout constraints.

### C.4 Macro placement strategy (P0 productivity multiplier)

- Keep AlphaChip soft-macro infra; extend to hard macros with Stage 1 SRAM compiler outputs.
- Evaluate **DREAMPlace 4.0** (timing-driven, GPU, 30× faster, no RL training cost) and **ChiPFormer** (offline-RL transformer, leverages existing placement corpus).
- For commercial path: Cerebrus AI Studio (Cadence partner), DSO.ai (Synopsys partner). Both report 10-20% PPA and 3-10× productivity uplift.

## D. Benchmarks, eval, testing

### D.1 What we can already measure

- AlphaChip vs OpenROAD proxy cost (exists, `compare_proxy_costs.sh`). E1 256-soft-macro: OpenROAD 0.2379 vs CT-CD 0.2308 (3.01% win). PPO RL pending GPU.
- OpenLane Sky130 release metrics (`final/metrics.json`).

### D.2 What is missing and must be added

- **Post-route PPA validator** for AlphaChip placements: re-run OpenROAD detailed route on AlphaChip-exported `.plc` and capture routed wirelength, DRC count, congestion histogram, hold/setup TNS, max-slew/cap violations. Today `compare_proxy_costs.sh` stops at proxy.
- **Multi-corner STA** evidence beyond OpenLane single-corner. Even on Sky130, run TT/SS/FF + 2 RC corners → 6-corner closure as methodology baseline.
- **IR-drop budget**: `pd/signoff/pdn-current/local-budget.md` exists as stub; replace with actual `OpenROAD psm` static-IR maps + Voltus/RedHawk dynamic-IR plan tagged "blocked: commercial tool" per AGENTS.md.
- **DFT / scan / ATPG**: status today is research-note only. Add Yosys+ABC scan-insertion pass and Fault-driven scan-chain stitching as Sky130-level evidence floor.

### D.3 PPA targets to commit to in spec-db

- **Big core (RV64GC, OoO) at N2P**: <2.5 mm² (A14 FireStorm complex 9.1 mm² at N5 with big L2; scaling N5→N2P ≈ 0.4-0.5×, so two-core complex at N2P ≈ 4-5 mm² → single big core <2.5 mm²).
- **Worst-corner frequency**: ≥3.5 GHz at SS/0.65V/125 °C. Apple/Qualcomm flagships hit ~3.5-4.0 GHz at TT.
- **NPU**: ~6-10 mm² at N2P for INT8/FP8 in 30-60 TOPS range, comparable to A18 Pro Neural Engine.
- **Open-flow PPA proof**: e1 sub-block (NPU MAC array, DMA engine, AXI-Lite interconnect) with cocotb-tested module → full OpenLane Sky130 closure → AlphaChip-optimized placement → re-run closure with reproducible metrics in `pd/signoff/`.
- **Reference die-shot comparison**: A14 = 88 mm² / 134 Mtr/mm² at N5; A17 Pro = 103 mm² at N3; Apple M4 = ~165 mm² at N3E. For 2028 phone at N2P, **die budget 120-150 mm²** with ~250-300 Mtr/mm².
- **Basilisk negative baseline**: 130 nm IHP SG13G2, 1.1 MGE, 77 MHz peak. Open-EDA ceiling. Argument for 2028 phone SoC: explicitly not at that ceiling — we plan foundry-EDA-partner route at N2P/14A.

## E. Optimizations: has / should / needs

### Has
- AlphaChip soft-macro benchmark + Nebius H200 training infrastructure.
- OpenLane Sky130 closure for `e1_chip_top` (DRC-clean, LVS-clean at preflight scale, std-cell-only).
- Schema-validated PD run manifest with tool image digest, corners, GDS/DEF/SDF/SPEF, 7 named checks.
- AI-EDA research inventory (10+ tools surveyed) and concrete next-step order.

### Should (Stage 1-2)
- Real hard SRAM/cache/PLL/IO macros in e1 floorplan (so AlphaChip becomes useful).
- OpenROAD AutoTuner sweep over existing OpenLane config.
- Multi-corner STA at Sky130 (proves methodology, surfaces ECO flow).
- DRC+LVS clean at IHP SG13G2 with Linux-capable subset (Basilisk-grade demonstrator).
- DREAMPlace 4.0 as GPU-accelerated placer benchmark side-by-side with TritonRoute.
- UPF / multi-power-domain flow on a small block.
- Scan insertion + Fault ATPG + tape-out checklist failing closed on missing DFT.

### Definitely needs (Stage 3, gating)
- Foundry PDK access (NDA-gated; without this, sub-7 nm closure impossible).
- Characterized library suite including LVF / SOCV at all corners (≥120 PVT × Vt × RC views at N2/N2P).
- Commercial signoff EDA: Innovus + Tempus + Voltus + Quantus + Pegasus OR Fusion Compiler + PrimeTime + RedHawk-SC + StarRC + IC Validator. OpenROAD remains useful for AutoTuner-driven exploration, ML-data generation (CircuitOps), and ML macro placement, but not for foundry signoff at N2 / N3 / 14A.
- IO/PHY hard IP: LPDDR5X/6 PHY, MIPI DSI/CSI, USB3 SS PHY, UFS host PHY, PCIe Gen5 PHY, RFFE, ePHY for sensors. None open-source at advanced nodes; license from Synopsys DesignWare, Cadence IP, Rambus, Alphawave is mandatory.
- DFT/BIST: full MBIST for every SRAM, JTAG boundary scan, DFT-MAX-style compression, in-system test points, post-silicon validation hooks.
- BSPDN / PowerVia floorplan-awareness if Stage 3 target is Intel 14A or TSMC A16; planning starts at floorplan, not PDN.
- Yield / DFM partnership with foundry CMP fill / litho-hotspot / antenna rule decks.

## F. Risks and open questions

1. **OpenROAD sub-7 nm is unproven**. Every published sub-7 nm result is research-grade on predictive ASAP7 PDK or NDA-gated GF12/Intel16. Zero published flagship-mobile signoff end-to-end in OpenROAD at N5 or below. Stage-3 plan must assume commercial tools.
2. **Commercial EDA licensing for an open project** is a real obstacle: Cadence/Synopsys are not in the habit of licensing for open-source tape-outs; realistic vehicle is startup license, foundry-funded shuttle, or university partnership.
3. **AlphaChip is open but compute is expensive**: published Ariane recipe used 8× V100; e1 Nebius H200 plan is equivalent for single block. Each retraining cycle (per netlist revision) is hours-to-days. Several reanalyses ("False Dawn" / Cheng et al. arXiv 2302.11014) show proxy-cost gains don't always translate to PPA wins; verification on routed PPA is mandatory.
4. **DFM / yield optimization** depends on foundry-confidential rules; no open path.
5. **BSPDN choice forces a 2026 commit**: A16 (BSPDN) vs N2P (no BSPDN, NanoFlex only) materially changes floorplan, std-cell choice, IR analysis. Wrong call wastes 6 months of PD work.
6. **Sky130 closure ≠ N2 closure**: current OpenLane release at FP_CORE_UTIL=20, CLOCK_PERIOD=100 ns is not proof of anything at flagship-mobile frequencies. Repo correctly fails-closed (`physical-power-thermal.md`: "Preflight success is not PD closure"). Architectural risk: AlphaChip wins on Sky130 don't transfer to N2P routing pressure.
7. **Open question — soft vs hard NPU IP**: if NPU is custom RTL, it goes through same N2P signoff. If hard-IP (ARM Ethos, Cadence Tensilica DNA), integration story simpler but loses openness.
8. **Open question — Linux distro + drivers**: Basilisk-class precedent only proves SoC boots Linux. Full Android requires GPU drivers (Mali/Adreno-class), modem driver, display drivers, vendor-grade BSP — out of scope of PD but blocks project end-to-end.

## Sources

- [OpenROAD - Tool Limitations](https://openroad-test.readthedocs.io/en/stable/user/ToolLimitations.html)
- [OpenROAD - Wikipedia](https://en.wikipedia.org/wiki/OpenROAD_Project)
- [OpenROAD 7nm Design Contest](https://theopenroadproject.org/the-openroad-7nm-design-contest-results-are-announced/)
- [OpenROAD ASAP7 PDK](https://github.com/The-OpenROAD-Project/asap7)
- [OpenROAD-flow-scripts](https://github.com/the-openroad-project/openroad-flow-scripts)
- [AlphaChip - DeepMind](https://deepmind.google/blog/how-alphachip-transformed-computer-chip-design/)
- [circuit_training (AlphaChip)](https://github.com/google-research/circuit_training)
- [Updated Assessment of RL for Macro Placement - arXiv 2302.11014](https://arxiv.org/html/2302.11014v3)
- [AlphaChip controversy](https://en.wikipedia.org/wiki/AlphaChip_(controversy))
- [Cadence Cerebrus AI Studio](https://www.cadence.com/en_US/home/tools/digital-design-and-signoff/soc-implementation-and-floorplanning/cadence-cerebrus-ai-studio.html)
- [Synopsys DSO.ai](https://www.synopsys.com/ai/ai-powered-eda/dso-ai.html)
- [Synopsys DSO.ai 100 tapeouts](https://news.synopsys.com/2023-02-07-AI-designed-Chips-Reach-Scale-with-First-100-Commercial-Tape-outs-Using-Synopsys-Technology)
- [Synopsys SF2 GAA flow certification](https://news.synopsys.com/2024-06-12-Synopsys-Achieves-Certification-of-its-AI-driven-Digital-and-Analog-Flows-and-IP-on-Samsung-Advanced-SF2-GAA-Process)
- [DREAMPlace GitHub](https://github.com/limbo018/DREAMPlace)
- AnandTech: TSMC N2P plans / NanoFlex
- [TSMC N2P loses BSPDN](https://www.tomshardware.com/tech-industry/tsmcs-2nm-nodes-get-nanoflex-n2p-loses-backside-power-delivery)
- [TSMC A16](https://www.tsmc.com/english/dedicatedFoundry/technology/logic/l_A16)
- [Intel 18A](https://www.intel.com/content/www/us/en/foundry/process/18a.html)
- [Intel 14A](https://www.tomshardware.com/tech-industry/semiconductors/intel-is-going-big-time-into-14a-says-ceo-lip-bu-tan-serve-the-customer-well-remark-hints-at-external-client)
- [imec BSPDN DTCO](https://www.imec-int.com/en/articles/backside-power-delivery-options-dtco-study)
- [Samsung BSPDN 17% area](https://semiwiki.com/forum/threads/samsung%E2%80%99s-backside-power-delivery-network-reportedly-to-reduce-2nm-chip-size-by-17.20857/)
- [Paripath - AOCV vs POCV](https://www.paripath.com/blog/variation-blog/comparing-aocv-to-pocv)
- [Cadence variation white paper](https://www.cadence.com/en_US/home/resources/white-papers/addressing-process-variation-and-reducing-timing-pessimism-at-16nm-and-below-wp.html)
- [EEJournal - MMMC views](https://www.eejournal.com/article/20121206-cadence/)
- [Cadence CCOpt training](https://www.cadence.com/en_US/home/training/all-courses/86198.html)
- [ChipXpert - CTS at 3 nm](https://chipxpert.in/clock-tree-synthesis-cts-complexity-advanced-nodes/)
- [Basilisk - End-to-End Open-Source Linux-Capable RISC-V SoC in 130nm - arXiv](https://arxiv.org/html/2406.15107v1)
- [Basilisk - Open EDA Tools](https://arxiv.org/abs/2405.03523)
- [Apple A14 die analysis - TechInsights](https://www.techinsights.com/blog/two-new-apple-socs-two-market-events-apple-a14-and-m1)
- [Sub-3 nm chiplets - Quest Global](https://www.questglobal.com/insights/thought-leadership/revolutionizing-semiconductor-design-in-the-sub-3nm-era-with-chiplets-3d-ics/)
- [Thermal management 2.5D/3D - MDPI](https://www.mdpi.com/2673-4117/6/12/373)
