# Integrated 2028 SOTA Report

Open RISC-V Android phone SoC (e1 → 2028 product). Cross-domain synthesis of eight specialist research reports under `sota-2028/`. Dated 2026-05-19.

This is a planning and claim-boundary artifact, not an implementation claim. Every numeric target here is gated by the existing fail-closed evidence pipeline (`docs/architecture-optimization/cpu-npu-2028-readiness-scorecard.yaml`, `docs/evidence/`, `pd/signoff/`).

## 0. Executive summary

The 2028 phone-class envelope is concrete and well-bounded by the 2025-2026 flagship cohort: Apple A19 Pro, Snapdragon 8 Elite Gen 5, Dimensity 9500, Exynos 2600, Tensor G5. Across every domain the same shape repeats:

- **Architectural target for 2028:** parity with C1-Ultra / Oryon Gen 3 in CPU (GB6 ST ≈ 3500, MT ≈ 9000); Dimensity 9500 in cache / SLC (~31-55 MB on-die SRAM); LPDDR5X-10667 baseline / LPDDR6-14400 stretch with 70-140 GB/s sustained; 80 TOPS sustained INT8 NPU; ~5 W peak / 3.5 W sustained at 95 °C Tj.
- **The repo today is at the L0 RTL prototype tier.** A tiny RV32 stub, an unwired CVA6 wrapper, a 4 KiB SRAM masquerading as DRAM, a Python NPU contract enforcer, Sky130 130 nm preflight at 10 MHz, 2-rail padframe, no LLVM build flow, no IOMMU, no caches, no PHY. Documentation honesty is excellent (every gate fail-closes); implementation is essentially zero.
- **The binary risk is foundry and IP access.** Every credible 2028 path requires (a) TSMC N2P / A14 or Intel 14A wafer access (Apple holds >50% of TSMC N2; tapeout NRE $250-400M), (b) licensed LPDDR5X/6 PHY from Synopsys/Cadence/Rambus (no open PHY exists), (c) commercial signoff EDA seats (Voltus/RedHawk-SC/PrimeTime; OpenROAD is unproven sub-7 nm), (d) a closed mobile-class PMIC or a multi-chip catalog PMIC daughtercard. The "open RISC-V" story has a hard wall at the analog/foundry tier.
- **Realistic schedule:** 2028 dev-board silicon, 2029 phone product. Hold this line in the spec docs.

## 1. Cross-domain SOTA snapshot (2025-2026 flagships)

| Domain | Snapdragon 8 Elite Gen 5 | Dimensity 9500 | Apple A19 Pro | Exynos 2600 | Tensor G5 |
|---|---|---|---|---|---|
| Process | TSMC N3P | TSMC N3P | TSMC N3P | Samsung SF2 (2 nm GAA) | TSMC N3 |
| Big core | Oryon Gen 3 Prime 4.74 GHz | C1-Ultra 4.21 GHz | A19 Pro P 4.26 GHz | C1-Ultra 3.8 GHz | Cortex-X4 3.78 GHz |
| Topology | 2+6 | 1+3+4 | 2+4 | 1+3+6 (reported) | 1+5+2 |
| Decode width (big) | 9-wide | 10-wide | ~9-wide native | 10-wide | 10-wide |
| ROB (big) | ~650 | ~2000 inflight | ~700 | similar to C1-Ultra | ~525 effective |
| L1I/L1D (big) | 192/128 KB | per Arm ref | ~192/128 KB | 64/128 KB | 64/64 KB |
| Private L2 (big) | 12 MB shared 2-Prime | 2 MB / core | 16 MB 2-P cluster | 3 MB | 2 MB |
| L3 cluster | — | 16 MB DSU L3 | — | 16 MB | DSU L3 |
| SLC | 8 MB | 10 MB | 32 MB | unspec | ~8 MB |
| DRAM | LPDDR5X-5300, 84.8 GB/s, ≤24 GB | LPDDR5X-10667, ~85 GB/s, ≤16 GB | LPDDR5X-9600, 75.8 GB/s, 12 GB | LPDDR5X-class | LPDDR5X, 12-16 GB |
| Coherent fabric | Qualcomm NoC (closed) | Arm DSU-120 + CI-700 (CHI) | Apple proprietary | Arm DSU + CMN | Arm DSU |
| IOMMU | Arm SMMU-700 | Arm SMMU | Apple IOMMU | Arm SMMU | Arm SMMU |
| BPU L1 BTB / RAS | ~2K + 2048-entry indirect / 48 | DSU+Arm BPU | ~44K total TAGE entries | similar to C1-Ultra | Arm BPU |
| Geekbench 6 ST/MT | 3649 / 11068 | 3502 / 10417 | 3834-3895 / 9988 | 3197 / 11065 | 2288 / 6030 |
| PMIC rails | 30-40 LDO + ~14 SMPS across 6-8 dies | MT6373+MT6363 (~11 SMPS + 20 LDO) | custom (~12-18 rails internal) | S2MPS27 | reused Samsung PMIC |
| BSPDN | no | no | no | no | no |

**No 2025-2026 flagship ships BSPDN.** Apple, Qualcomm, MediaTek, Samsung, Google all use frontside power delivery on TSMC N3P / Samsung SF2. BSPDN first appears at Intel 18A (Dec 2025 HVM) and TSMC A16 (2027 HVM). TSMC's mobile A14 in 2028 is frontside-only; the BSPDN A14 variant ("A12") slips to 2029. For a 2028 phone product, frontside PDN is the safe call.

## 2. 2028 target envelope

Consolidated hard numbers. Where two appear (MVP / stretch), MVP is the baseline SKU and stretch is the AI-heavy SKU.

### 2.1 CPU cluster (1×Ultra + 3×Premium + 4×Pro)

| Spec | Ultra big | Premium mid | Pro little |
|---|---|---|---|
| ISA | RVA23 + V (VLEN=256) + Zfh/Zvfh/Zvbb/Zvkt + Zicfilp/Zicfiss + Ztso (PTE-bit) + Sv57 | RVA23+V (VLEN=128) | RVA23 |
| Width | 8-wide decode (+2 fused) | 6-wide decode | 1-2-wide in-order |
| ROB / inflight | 512 | 256 | n/a |
| PRF (INT/FP-V) | 400 / 400 (256-bit V regs) | 192 / 192 | small |
| Branch predictor | TAGE-SC-L + ITTAGE + uFTB 512 + FTB 8K + L2 BTB 16K + RAS 32/64 + SC + loop, 2 taken/cycle, ≤14 cyc penalty | XiangShan-class TAGE-SC | bimodal+BTB+RAS |
| L1I / L1D | 64 KB 8-way / 64 KB 8-way (stretch 96 KB) | 64 / 64 KB 4-way | 32 / 32 KB 4-way |
| Private L2 | 2 MB 8-way | 1 MB 8-way | 256-512 KB 4-way |
| TLB | 64 L1 + 2048 L2 unified, Sv48/57, 4K/2M/1G pages | smaller | smaller |
| Memory ordering | RVWMO + Ztso per-page | RVWMO | RVWMO |
| Clock | 4.0-4.3 GHz typical, 4.5 burst | 3.2-3.4 GHz | 2.4-2.6 GHz |
| IPC SPEC2017int | ≥ 9 | ~5 | ~1.6 |
| Area (N2P class) | ~2.0 mm² incl L2 | ~0.85 mm² | ~0.25 mm² |
| Power | 1.4 W sustained / 2.8 W burst | 0.8 W / 1.6 W | 0.3 W / 0.7 W |
| Recommended open base | fork Tenstorrent Ascalon-D8 (Apache, 8-wide, LLVM-upstream); fallback XiangShan Kunminghu V3 scaled to 8-wide | XiangShan Kunminghu V3 (Mulan PSL v2) | CVA6 (Apache/Solderpad) |

Management hart: Ibex (lowRISC, Apache-2.0) on AON rail for boot, security, PMU, RPMI firmware.

### 2.2 Cache + fabric

- Cluster L3 (DSU-class): 8 MB MVP / 16 MB stretch, 16-way, mostly-inclusive, Mockingjay replacement (Hawkeye fallback), ~25 cyc.
- SLC: 16 MB MVP / 32 MB stretch, 16-way, 4-8 banks, per-client QoS classes (display RT > camera > CPU-FG > NPU > GPU > DMA-bulk), way-partitioning, way-shutoff DVFS, BDI compression. CPU-side ~50 cyc.
- Coherence protocol: MESI MVP (TileLink TL-C native); MOESI as v2 once formal verification is in place.
- Fabric: TileLink TL-C inside CPU cluster; AXI4 + ACE-Lite for accelerators; CHI bridge at the SLC↔DRAM and NoC boundary so Arm/Synopsys verification IP plugs in.
- NoC topology: 2D-mesh CMN-S3-class, 4-6 home nodes, 2 memory home nodes per channel.
- NPU coherency: IO-coherent on reads, non-coherent + dma-buf cache-maintenance on writes.
- Total on-die SRAM: ~31 MB MVP (7 L2 + 8 L3 + 16 SLC) / ~55 MB stretch (7 + 16 + 32) — A19-Pro territory at stretch.

### 2.3 DRAM + memory subsystem

- Baseline SKU: LPDDR5X-10667, 4×16-bit = 64-bit, 85.3 GB/s peak, ~70 GB/s sustained, 12-16 GB capacity. ECC on-die + link-ECC always-on.
- AI SKU (stretch): LPDDR6-14400, 4×24-bit logical (8×12-bit sub-channels), ~172.8 GB/s peak, ~140 GB/s sustained, 24 GB capacity using 32 Gb dies × 4.
- PHY (licensed, non-negotiable): Synopsys DesignWare LPDDR6/5X PHY at 14.4/10.67 Gbps, or Cadence LPDDR6/5X IP, or Rambus. DFI 5.0 controller interface.
- IOMMU: RISC-V IOMMU v1.0.1 (ratified Sep 2024) with G-stage, PASID, page-request, fault queue, ATS. Per-stream contexts for NPU command queues, display planes, camera ISP, GPU, DMA.
- Refresh: per-bank refresh + temperature-compensated; scrub on TEE/keyslot regions.
- AFBC display compression + lossless NPU activation compression to recover 30 GB/s headroom.
- Repo gate inconsistency to reconcile: `soc-optimized-operating-point.yaml` presumes 240 GB/s; `uma-dram-evidence-gate.yaml` requires 120 GB/s; LPDDR5X 64-bit caps at 85 GB/s. Split SKUs.

### 2.4 Process + power + PD

| Item | 2028 commitment |
|---|---|
| Process primary | TSMC N2P (HVM 2H 2026, mobile-mature by 2028, frontside PDN) |
| Process stretch | TSMC A14 baseline (HVM 2028, frontside) or Intel 14A (BSPDN + High-NA, strategic 2nd source) |
| Density target | ~313 MTr/mm² HD logic (N2 class); SRAM macro 38.1 Mb/mm² |
| Die area budget | 100-130 mm² (flagship-mobile band) |
| Wafer / NRE | $30-45k/wafer; $250-400M total tapeout NRE |
| Power envelope | 5 W peak / 3.5 W sustained @ 95 °C Tj |
| Rail count | 16 rails (3 CPU clusters + NPU + GPU + SOC fabric + SRAM + 4 LPDDR rails + analog + AON + PMC + 2 IO + USB PHY + RF ref) |
| Regulator strategy | External buck per primary rail + per-core dLDO on big-CPU and NPU for fast DVFS; AON retention LDO |
| Droop response | <20 ns dLDO + 1-cycle clock stretcher + AVFS with PVT-compensated canary FFs |
| Power-mgmt firmware | RISC-V SBI MPxy + RPMI v1.0 (ratified) — drop-in equivalent to Arm SCMI; Linux drivers landed 2025 in 6.x |
| Mgmt core | Ibex RV32IMC on AON rail |
| Decap | SHPMIM-class on-die MIM (~150 nF/mm² in hot blocks), ~5× Cdec/Iavg total |
| PDN signoff | Voltus or RedHawk-SC dynamic IR + EM, 16-32 corners, multi-Vt; OpenROAD `psm` only for triage |
| Macro placement | AlphaChip RL (open) or DREAMPlace 4.0 (open, GPU, 30× faster) for soft+hard macros; commercial Cerebrus AI Studio / DSO.ai if partner available |
| Clock tree | CCOpt or ClockMesh+ConcurrentClockData (mesh + leaf H-tree hybrid is N3/N2 standard); TritonCTS is triage |
| STA | MMMC POCV/SOCV with LVF, 100-200 effective corners, ML pruning to 32-64 |
| Open-PDK demonstrator track | IHP SG13G2 130 nm + Sky130 (Basilisk-class, ~77 MHz ceiling — proves open methodology, not perf) |

### 2.5 Compiler + software

| Layer | 2028 baseline |
|---|---|
| Toolchain | LLVM trunk pinned; `-mcpu=eliza-e1 -march=rva23u64 -O3 -flto=thin -fprofile-sample-use=… -fbasic-block-sections=labels` then Propeller relink then BOLT |
| Vector | RVV 1.0 VLEN=256 in CPU; autovec + hand-tuned intrinsics for top-20 kernels |
| Matrix | Live in NPU only; do not depend on AME/IME/VME ratification (AME data-type vote recalled Dec 2025) |
| NPU compiler | MLIR/IREE with custom `elizanpu` dialect emitting descriptors → command queue → tile DMA |
| PyTorch path | ExecuTorch backend → IREE |
| TFLite/LiteRT | NNAPI/AIDL HAL wired to descriptor submission; INT2/INT4/FP8 ops |
| Quantization | PTQ INT8 baseline; AWQ INT4 weight-only for LLMs; FP8 E4M3 on long-context; 2:4 sparsity wired (chip already has SDOT4_S4_2_4) |
| Android | RVA23 mandatory; ART RISC-V backend optimization (vendor work); baseline profiles + profile-guided dexopt; ThinLTO in system image |
| CFI | Zicfilp + Zicfiss landing-pad + shadow-stack on by default |
| AutoFDO+Propeller+BOLT measured uplift | 12-18% on full system image (10% AutoFDO+Propeller, 2-6% BOLT, ~2% MFS), net 5-10% after Spectre mitigations |
| Kernel | Linux 6.19+ with RISC-V Spectre mitigations (5-10% cost); SBI MPxy + RPMI for power; mainline RISC-V IOMMU driver |

## 3. Cross-domain risks and IP walls

Most-cited blockers, deduplicated across the 8 sub-reports:

| Wall | Domain | Impact |
|---|---|---|
| No open LPDDR5X/6 PHY exists | Memory, PD | Must license Synopsys / Cadence / Rambus. Breaks "open RISC-V" narrative at analog tier. License mid-7-figures + per-chip royalty. PHY occupies 5-7 mm². |
| Foundry access at N2P / A14 / 14A | Process, PD | Apple holds >50% of TSMC N2 through 2027 Q2. Open project has no leverage at TSMC. Realistic path: Intel Foundry Services (DARPA/RAMP-C subsidy) or hyperscaler/government anchor. |
| Tapeout NRE | Process | $250-400M single tapeout at N2P; $300-500M at A14. Open-source funding models do not reach this scale; needs commercial customer or government program. |
| Commercial signoff EDA is closed | PD, Power | Voltus, RedHawk-SC, PrimeTime, Tempus, Quantus, IC Validator, Pegasus. OpenROAD has zero certified PDKs sub-7 nm. Plan for $5M+/year EDA license budget. |
| No open mobile-class PMIC IP | Power | v0 must use 6-8 catalog buck/LDO ICs on daughtercard, controlled via I²C/SPMI by mgmt core. v1 internalizes. |
| RISC-V IOMMU driver maturity | Memory | Spec ratified Sep 2024, Linux driver landed v6.10-6.12. Android dma-buf v2 + gralloc + NN HAL bindings need contributor work through 2026-2027. |
| AME/IME/VME matrix not ratified for 2028 | OoO, Compiler | Plan around RVV-1.0 + NPU matrix. Do not assume standard matrix ISA in 2028 ship. |
| AOSP RISC-V Tier-1 still volatile | Compiler | Google removed RISC-V from AOSP common kernel April 2024, reinstated Tier-1 late 2025. Pin our own AOSP branch with checked-in manifest SHA. |
| OpenROAD sub-7 nm unproven | PD | Largest open-flow Linux-capable SoC: Basilisk at 130 nm, 77 MHz. Stage-3 N2P closure assumes commercial tools. |
| AlphaChip proxy ≠ PPA win | PD | "False Dawn" + arXiv 2302.11014 reanalysis. e1 256-macro smoke: 3.01% proxy win, but verification on routed PPA mandatory. |
| RVV autovec lags SVE2 in LLVM | Compiler | Igalia data shows 9% geomean uplift in 18 months; predication and stride loads still mis-costed. Closing fast; will be near closed by 2027. Hand-tune top-20 kernels. |
| Closed-vendor NPU stacks (QNN, NeuroPilot, Core ML) are years ahead | Compiler, NPU | IREE+ExecuTorch is the best open answer but is 1.5-3× slower than vendor SDKs on like-for-like models in 2026. |
| BSPDN thermal penalty + DFT complications | Process, PD | If 2029 A14P / Intel 14A variant is built. Active layer buried in BEOL; Tj rises 5-10 °C; probe access changes; multi-quarter learning curve. |
| SRAM scaling stalled at N3 | Process, Cache | TSMC N3 only ~5% SRAM density improvement vs N5. N2 resumes via macro-level density (38.1 Mb/mm²), not bitcell shrink. Size SLC twice — once for N2, once for 14A. |
| Repo gate inconsistency: 240 vs 120 GB/s | Memory, Power | `soc-optimized-operating-point.yaml` presumes 240 GB/s sustained; gate requires 120 GB/s. LPDDR5X 64-bit caps at 85 GB/s. Split SKUs to reconcile. |

## 4. Benchmark + comparison matrix

Unified eval gauntlet across all domains. Mandatory artifacts before any 2028 claim.

| Layer | Metric | Tool | 2028 target | Comparator |
|---|---|---|---|---|
| CPU big | SPEC CPU2017 intrate / core | SPEC + LLVM | ≥9 | X925 ~11.8, A19 ~12 |
| CPU big | Geekbench 6 ST | GB6 | ≥2800 | A19 Pro 3895, Oryon Gen 3 3649, C1-Ultra 3502 |
| CPU big | Geekbench 6 MT | GB6 | ≥8500 | S8E5 11068, D9500 10417, A19 Pro 9988 |
| CPU big | CoreMark / MHz | CoreMark | ≥10 | X925 ~13, Zen 5 ~12.5 |
| CPU | JetStream2 | V8 / Hermes | ≥250 | Android/Chrome reality check |
| Front-end | SPECint avg MPKI | gem5-XiangShan + traces | ≤4.0 | TAGE-SC-L 64KB ≈ 3.986 |
| Front-end | Android cold-launch MPKI | simpleperf + gem5 | ≤8 | dominated by I-footprint, not direction misprediction |
| Front-end | Taken-branch throughput | microbenchmark | ≥1.5/cycle sustained | 2 taken/cycle = Zen 5/X925/Lion Cove parity |
| Cache | lmbench `lat_mem_rd` curve | lmbench | publish full curve | chipsandcheese A-series / X-series curves |
| Cache | STREAM Triad | STREAM | ≥120 GB/s stretch / ≥70 baseline | Apple A19 Pro 75.8 GB/s, D9500 ~85 GB/s |
| Cache | LLC IPC vs LRU | ChampSim + DPC-3 | +12-15% (Mockingjay) | published Mockingjay/Hawkeye numbers |
| Memory | lmbench `bw_mem` sustained | lmbench | ≥120 GB/s | S8E5 84.8, D9500 ~85 |
| Memory | Pointer-chase p95 latency | lmbench | ≤120 ns | Apple A-series ~115 ns |
| Memory | UFS+DRAM contention | fio + STREAM | UFS BW degrade ≤15% under DRAM saturation | UFS 4.1 |
| Memory | dma-buf stale-buffer negative | bespoke | must fault or be statically forbidden | required by uma-coherency-validation-strategy |
| Memory | IOMMU fault injection | bespoke | fault entry has master / IOVA / access / syndrome | RISC-V IOMMU spec |
| NPU | MLPerf Mobile / Tiny | LiteRT + ExecuTorch | per `npu-2028-target.yaml` | Snapdragon 8 Elite Gen 5 / Dimensity 9500 MLPerf |
| NPU | unsupported_ops / cpu_fallback_pct | per-model report | ≤1% fallback | published vendor model lists |
| Concurrent | Display underflow at 120 Hz QHD + NPU + camera + CPU | bespoke | 0 underflow events | this is the SLC-pays-its-rent test |
| Process | DTCO sensitivity | OpenLane × {Sky130, GF180, IHP SG13, ASAP7} | clean DRC/LVS, timing-clean at design freq for each PDK | Basilisk at 130 nm 77 MHz |
| Process | Multi-corner STA | OpenSTA / PrimeTime | 16-32 dominant corners, ML pruning from 100-200 | N3/N2 industry practice |
| Power | Activity-traced power | PrimePower / Voltus + workload VCDs | matches modeled operating point | competitor sustained scores (independent reviews) |
| Power | Static + dynamic IR-drop | Voltus / RedHawk-SC | <5% nominal static / <10% dynamic | foundry sign-off |
| Power | Sustained perf vs Tj | 30-min real-workload runs | sustained GB6 MT ≥8500 | A19 Pro ~8500, S8E5 ~9200, D9500 ~8400 |
| Compiler | LLVM nightly llvm-test-suite | LLVM CI | no regressions | LLVM trunk |
| Compiler | AutoFDO + Propeller + BOLT uplift | full build matrix | 5-10% net (after Spectre) | Google AutoFDO+Propeller 10% kernel |
| Compiler | RVV autovec quality | Igalia-style 16-50 kernel suite | ≥ LLVM-stock geomean | GCC 15 / SVE2 reference |
| Android | Cold-start ms (Chrome, YouTube, Maps) | perfetto / systrace | ≤900 ms Chrome cold | D9500-class flagship |
| Security | Zicfilp + Zicfiss enabled | runtime check | on by default | matches BTI/SCS in Android |

## 5. Optimization inventory: has / should / needs

### Has (today)
- Tiny RV32 stub + CVA6 wrapper (toy BPU); Chipyard Rocket integration manifest.
- AXI-Lite scaffold with CPU-priority arbitration, decode-err sticky reg, watchdog.
- 4 KiB SRAM "DRAM" model; Chipyard SimDRAM 256 MiB Verilator model (generated, no built sim).
- Python NPU contract enforcer with scalar/packed dot ops, bounded 3×3×7 INT8/INT4 GEMM, descriptor ring, INT2 / FP8 E4M3 scalar opcodes, 2:4 structured sparse INT4 dot.
- AlphaChip soft-macro training infrastructure (Nebius H200), 3.01% proxy-cost win on 256-macro e1 benchmark vs OpenROAD.
- OpenLane Sky130 release run: 6.25 mm² die, 142K cells, 0 macros, clean DRC/LVS at 100 ns clock.
- 2-rail demo padframe; modeled operating point optimizer with corner sweep.
- Fail-closed evidence gates for every claim; 14A process-effects derate model.

### Should (2026-2027, no advanced-node spend required)
1. CVA6 → BOOM/XiangShan integration as the actual application core in OpenLane release flow (not wrapper). Linux boot on QEMU/Renode/FireSim.
2. Real LLVM RISC-V toolchain pinned (LLVM trunk, RVV intrinsics headers, ThinLTO+sample-PGO+basic-block-sections recipe).
3. MLIR/IREE `elizanpu` dialect lowering linalg.matmul/conv/attention/softmax/layer-norm to descriptor ring — replaces Python smoke.
4. ExecuTorch RISC-V backend prototype for PyTorch mobile deployment.
5. AutoFDO + Propeller + BOLT harness with profile capture on Verilator/QEMU.
6. Real hard SRAM macros in OpenLane floorplan (OpenRAM Sky130; IHP SRAM for SG13G2) so AlphaChip becomes useful.
7. ASAP7 predictive sign-off for big core / NPU tile / SLC slice — gives FinFET-class timing/power shape.
8. Multi-corner STA at open PDKs (SS/TT/FF + 2 RC corners on Sky130) — exercises methodology.
9. NoC + IOMMU + cache-coherent fabric RTL (TileLink TL-C + CHI bridge, RISC-V IOMMU v1.0.1).
10. Cache-hierarchy RTL (real L1, private L2, shared L3, SLC with Mockingjay/Hawkeye replacement, Berti + FDIP prefetchers, BDI compression on SLC).
11. Branch predictor RTL (track XiangShan Kunminghu v2→v3: TAGE-SC + ITTAGE + FTB + RAS + SC + loop) — currently zero in repo.
12. `docs/arch/branch-prediction.md` contract + `eliza-kunminghu-manifest.json` pinning open BPU IP commit hash.
13. Droop sensor + clock stretcher RTL (port public 22 nm-style ADCD; ~1 engineer-month).
14. UPF / multi-power-domain flow authored: 16 power domains, isolation cells, retention strategy.
15. DFT / scan / ATPG flow (Yosys+ABC scan insertion + Fault for SG13/Sky130 baseline).
16. OpenROAD AutoTuner sweep around utilization/density/CTS skew/route caps.
17. DREAMPlace 4.0 GPU-placer benchmark side-by-side with TritonRoute.
18. `pd/openlane/config.<node>.json` per target (sky130, gf180, ihp-sg13, asap7-predictive, n2p-stub, a14-stub).
19. Reconcile 240 GB/s vs 120 GB/s in `soc-optimized-operating-point.yaml` and `uma-dram-evidence-gate.yaml` — split LPDDR5X baseline / LPDDR6 stretch SKUs.
20. RFC: SBI MPxy + RPMI as power-management ABI.

### Needs (2028 hard requirements; gates ship)
1. Foundry PDK access (TSMC N2P or A14, or Intel 18A/14A). Binary risk.
2. LPDDR5X/6 PHY license (Synopsys/Cadence/Rambus, DFI 5.0). Non-negotiable.
3. Other hard IP licenses: USB 3.2/4 PHY, MIPI D-PHY v3 / C-PHY v2 / DSI-2 / CSI-2, PCIe Gen5 PHY (if used), foundry SRAM compiler, multi-port SRAM, PLL/clock, analog (PMIC LDOs, ADC, temp sensor, eFuse).
4. Commercial signoff EDA (Cadence Innovus+Tempus+Voltus+Quantus+Pegasus, OR Synopsys Fusion Compiler+PrimeTime+RedHawk-SC+StarRC+IC Validator).
5. Characterized library at the target node: ≥120 PVT × Vt × RC corners with LVF/SOCV.
6. PMIC selection finalized: catalog-PMIC daughtercard for v0 vs licensed/custom for v1.
7. Per-cluster fast DVFS via on-die dLDOs (CPU big, NPU) + AVFS + droop sensors + clock stretchers.
8. RISC-V IOMMU v1.0.1 with G-stage, PASID, page-request, fault queue, ATS, plus Linux RISC-V IOMMU driver upstream maturity.
9. NPU command-queue + DMA + IOMMU isolation + per-context faults + thermal counters (vs current MMIO scalar prototype).
10. Tensor execution paths for FP8 E4M3 and INT2 (vs current scalar-only DOT4_FP8_E4M3 / DOT16_S2).
11. Open-flow validation track: end-to-end OpenLane closure at Sky130 + IHP SG13G2 with hard macros, scan, MBIST — proves methodology before $250M tapeout.
12. Real DRAM controller RTL (not the 4 KiB SRAM stand-in) attached to licensed PHY.
13. Memory-side QoS with 4-class scheduler (display RT > camera > CPU-FG > NPU > GPU > DMA-bulk) + per-master BW meters + latency targets.
14. AFBC + lossless NPU activation compression to recover bandwidth headroom.
15. Multi-mode multi-corner STA + POCV/SOCV with LVF at advanced node.
16. PD signoff: full dynamic IR-drop, EM, antenna, DFM, multi-Vt, mixed-low-power UPF flow.
17. BSPDN-aware floorplan + thermal model (only if stretch A14P / 14A path is selected; 2029 product).
18. Android RVA23 prebuilts + Bionic cross + NDK + AOSP branch pinning + NNAPI/AIDL HAL skeleton + ExecuTorch backend.
19. Reproducible CI: pinned Docker base, flake.lock, LLVM SHA, OpenLane SHA, mobile_smoke.tflite checksum.
20. Cooley/RVI legal review on Mulan PSL v2 (XiangShan) and Tenstorrent Ascalon mobile licensing.

## 6. Prioritized work order

**P0 (Q3-Q4 2026): repo discipline + decisions that cannot slip.**
- Pick big core: Tenstorrent Ascalon-D8 mobile-license path or XiangShan Kunminghu V3 fork. Decision deadline Q4 2026.
- Pick process target shortlist: TSMC N2P primary, A14 stretch, Intel 14A 2nd source. Begin foundry conversation.
- Pick fabric: TileLink TL-C inside cluster + CHI bridge at SLC. Commit one.
- Reconcile `soc-optimized-operating-point.yaml` vs `uma-dram-evidence-gate.yaml`; split LPDDR5X / LPDDR6 SKUs.
- Promote "custom LPDDR5X/LPDDR6 PHY" in `mobile-sota-2026.yaml` from non-goal to procurement requirement with vendor shortlist.
- Add branch-prediction scorecard entry + `docs/arch/branch-prediction.md` contract.
- LLVM trunk pinned + RISC-V toolchain prebuilts for RVA23U64.

**P1 (Q1-Q2 2027): buildout that does not need an advanced-node PDK.**
- BOOM/XiangShan/CVA6 hierarchy wired through Chipyard with real caches + IOMMU + TileLink.
- MLIR/IREE `elizanpu` dialect; ExecuTorch RISC-V backend prototype.
- OpenLane full closure at Sky130 + IHP SG13G2 with real SRAM/PLL macros.
- AlphaChip + DREAMPlace head-to-head with post-route PPA, not just proxy.
- AutoFDO + Propeller + BOLT pipeline on the system image.
- Droop sensor + clock stretcher + dLDO RTL ported.
- UPF authored for 16-domain partitioning.
- ASAP7 predictive signoff of big core + NPU tile.
- Pin Docker / flake / LLVM SHA / model checksums.

**P2 (Q3 2027 — Q2 2028): advanced-node closure.**
- Foundry PDK access + commercial EDA seats secured.
- Hard-IP licenses signed (LPDDR PHY, USB, MIPI, PLL, SRAM compiler).
- N2P (or A14) full multi-corner signoff: MMMC POCV/SOCV with LVF, 32 effective corners.
- Voltus / RedHawk-SC dynamic IR-drop + EM at workload activity.
- BSPDN-aware floorplan if A14P / 14A path is on.
- AOSP RISC-V branch pinned with manifest SHA; CTS/VTS subset on Cuttlefish.
- MLPerf Mobile + AI Benchmark v6 reference numbers on Verilator + FireSim.

**P3 (Q3-Q4 2028): tapeout, dev-board, bring-up.**
- Dev-board silicon Q3 2028.
- Sample bring-up Q4 2028.
- Phone product 2029.

## 7. Claim boundaries

- Today the repo cannot claim any of: a flagship CPU, a phone-class memory subsystem, a mobile-class NPU, an Android-capable system, any TOPS/IPC/GB6 number, any sustained perf, any thermal closure, any signoff-grade PD.
- The 2028 envelope is a target for architecture planning and evidence gates, not proof the design meets those numbers.
- Every future numerical claim must cite: exact artifact, command, device, clock, power, thermal state, software build, source revision.
- The credible 2028 ambition is C1-Ultra / Oryon Gen 3 parity, not Apple A19 Pro parity. Apple's process+frontend+SLC lead is a decade of compounding closed investment.
- The credible product ship date is 2029 phone with 2028 dev-board silicon. Hold this line.

## 8. Sub-reports

Per-domain research artifacts (full sources, tables, citations):

- [Branch predictors](sota-2028/branch-predictors.md)
- [Cache hierarchies](sota-2028/cache-hierarchies.md)
- [Memory subsystem](sota-2028/memory-subsystem.md)
- [OoO execution](sota-2028/ooo-execution.md)
- [Process nodes](sota-2028/process-nodes.md)
- [Power delivery](sota-2028/power-delivery.md)
- [Physical design](sota-2028/physical-design.md)
- [Compiler tuning](sota-2028/compiler-tuning.md)
