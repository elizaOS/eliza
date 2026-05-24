# Cache Hierarchy SOTA — 2028 RISC-V Phone-Class AP

Sub-report of [2028-sota-integrated-report.md](../2028-sota-integrated-report.md).

## A. SOTA Snapshot (2025-2026 flagship mobile)

### A.1 Per-core L1 / private L2

| SoC | Big L1I / L1D | Big private L2 | Mid L2 | Little L2 |
|---|---|---|---|---|
| Snapdragon 8 Elite Gen 5 (Oryon Gen 3, 2 Prime + 6 Perf) | 192 KB L1I / 128 KB L1D on Prime; 128 KB on Perf | shared 12 MB L2 / 2 Prime | shared 12 MB / 6 Perf | n/a |
| MediaTek Dimensity 9500 (1 C1-Ultra + 3 C1-Premium + 4 C1-Pro) | per-Arm | 2 MB C1-Ultra | 1 MB / C1-Premium | 512 KB / C1-Pro |
| Apple A19 Pro (2 P + 4 E) | 192/128 KB P; 128/64 KB E | 16 MB shared 2-P | n/a | 6 MB shared 4-E |
| Apple M5 (4 P + 6 E) | 192/128 P, 128/64 E | per-cluster L2 (multi-MB) | n/a | per-cluster E-L2 |
| Tensor G5 (1 X4 + 5 A725 + 2 A520) | Arm stock | 2 MB X4 | 1 MB A725 | 128-256 KB A520 |
| Exynos 2600 (1 + 3 + 6) | 64/128 KB C1-Ultra; 64/64 KB C1-Pro | 3 MB C1-Ultra | 1 MB C1-Pro | same |
| Arm Cortex-X925 (2025 IP) | 64/64 KB fixed | 2 MB 8-way or 3 MB 12-way | n/a | n/a |

### A.2 Shared cluster cache / L3 / DSU and SLC

| SoC | Cluster L3 | SLC | Total on-die SRAM |
|---|---|---|---|
| Snapdragon 8 Elite Gen 5 | none separate (per-cluster L2 instead) | 8 MB SLC | ~24 L2 + 8 SLC ≈ 32 MB |
| Dimensity 9500 | 16 MB DSU L3 | 10 MB SLC | 7 L2 + 16 L3 + 10 SLC ≈ 33 MB |
| Apple A19 Pro | none separate | 32 MB SLC | 16 P-L2 + 6 E-L2 + 32 SLC = 54 MB |
| Apple A19 | same | 12 MB SLC | 22 L2 + 12 SLC |
| Apple M5 | per-cluster | ~32 MB SLC | dozens of MB |
| Exynos 2600 | 16 MB L3 | unspec | ~28 MB |
| Snapdragon X2 Elite (PC ref) | per-cluster | 8 MB SLC at 228 GB/s memory | — |

### A.3 Prefetchers

| Prefetcher | Class | Best result | Notes |
|---|---|---|---|
| Stride / next-line | L1D, L1I | trivial baseline | universal floor |
| IPCP (ISCA'20) | L1D | ~6% IPC over baseline on SPEC | CS / CPLX / NL |
| Bingo (HPCA'19) | L1D | strong on irregular | short + long footprints |
| SPP (MICRO'16) | L2 | signature-based, scalable | DPC-3 winner-class |
| Berti (MICRO'22) | L1D | beats IPCP/Bingo on most SPEC | local-delta timing-aware |
| Pythia (MICRO'21) | hybrid | +3.4% over MLOP, +3.8% over Bingo, +4.3% over SPP | online RL agent |
| SPPAM (2026) | hybrid | +31.4% over no-prefetch, +6.2% over Berti+Pythia baseline | latest published |
| FDIP (1999, revisited 2020) | L1I front-end | covers most I-miss when BTB large | foundation for modern Arm/Intel |
| UDP / PDIP / DEER | L1I | improves FDIP for mobile/data-center large-footprint | DEER specifically targets modern mobile |
| Mockingjay (HPCA'22) | LLC replacement | +15.2% over LRU, beats Hawkeye +12.9% and SHiP +7.6% | Belady-MIN mimicry by expected hit count |
| Hawkeye (ISCA'16) | LLC | +12.9% over LRU | learns from past Belady oracle |
| DRRIP (ISCA'10) | LLC | classical, easy in RTL | set-dueling SRRIP vs BRRIP |

Mobile-vendor public prefetcher detail is thin. Apple uses multiple AMP/spatial/temporal prefetchers with deep lookahead; Arm DSU L3 ships with Best Offset Prefetch and stride; Snapdragon X-class Oryon publicly described as having aggressive PC-keyed stride+stream and a big BTB.

### A.4 Coherence fabric

| SoC | Fabric | Protocol |
|---|---|---|
| Snapdragon 8 Elite Gen 5 | Qualcomm proprietary NoC | MOESI-class, snoop+directory hybrid |
| Dimensity 9500 / Exynos 2600 / Tensor | Arm DSU-120 / DSU + CI-700 (mobile CMN) | AMBA 5 CHI, MESI/MOESI-style |
| Apple A19 Pro / M5 | Apple proprietary | Directory-based, exclusive SLC on M-series |
| Open RISC-V (XiangShan Kunminghu) | CHI-style L2/L3 (CoupledL2) | MESI-equivalent |
| Chipyard / Rocket / BOOM | TileLink TL-C | MESI-equivalent |

### A.5 Replacement in production silicon

- Arm DSU L3 + CMN SLC: per-set RRIP variants with tunable promotion. CMN-700 documents "QoS regulation" and "system cache partitioning."
- Apple SLC: research paper EXAM (USENIX 2025) shows M-series SLC partitioned exclusive — strong isolation used as side-channel attack surface.
- Snapdragon SLC: undocumented; CCC traces suggest pseudo-LRU + DIP family.
- Academic SOTA: Mockingjay is the strongest single-policy LLC replacement; Drishti (MICRO'25) adds +5.6% on Hawkeye / +13.2% on Mockingjay at 32-core scale.

## B. Current state in `packages/chip`

Inspected files: `docs/arch/{cache-hierarchy,cpu-subsystem,memory-subsystem,interconnect}.md`, `rtl/cache/`, `rtl/memory/`, and the cache evidence gates.

- The local cache scaffold now includes L1I/L1D, private L2, shared L3, SLC, BDI compression, prefetcher options, replacement policies, and a MESI directory coherence gate.
- `make cache-hierarchy-claim-gate` checks the scaffold and chains the SMP coherence report, but its claim boundary is still local RTL/scoped synthetic evidence only.
- Phone-class IPC, latency, sustained bandwidth, silicon, Linux, Android, DRAM, LPDDR, and release claims remain blocked until measured full-system or target evidence lands.
- The older AXI-Lite SRAM memory scaffold is still not a phone-class memory subsystem, even though separate AXI4 DRAM-controller simulation evidence now exists.

Bottom line: cache hierarchy RTL is present and locally gated, but it is not yet integrated as phone-class measured cache/memory evidence.

## C. Recommended 2028 cache hierarchy

### C.1 L1 (per core)

| Property | Big OoO | Mid OoO | Little in-order |
|---|---|---|---|
| L1I size / assoc / line | 64 KB / 8-way / 64 B (stretch 96 KB) | 64 KB / 4-way / 64 B | 32 KB / 4-way / 64 B |
| L1D size / assoc / line | 64 KB / 8-way / 64 B (stretch 96 KB) | 64 KB / 4-way / 64 B | 32 KB / 4-way / 64 B |
| L1D bandwidth | 2× 128-bit R + 2× 128-bit W /cycle | 1× 128-bit R/W | 1× 64-bit R/W |
| Load-use latency | 4 cyc | 4 cyc | 3 cyc |
| Inclusion w.r.t. L2 | non-inclusive | non-inclusive | inclusive |
| L1I prefetcher | FDIP with ≥8K BTB, decoupled FTQ | FDIP-lite | next-line only |
| L1D prefetcher | Berti + IP-stride + next-line; optional Pythia | IPCP-lite | stride only |
| Hardware TLB | 64 L1I / 96 L1D, fully assoc; 4 KB/2 MB/1 GB | 48/64 | 32/32 |

64 KB L1 matches Cortex-X925 sweet spot and XiangShan Kunminghu targets. Apple-class 192 KB L1I costs area, energy, tag-check latency.

### C.2 Private L2 (per core)

- Big core: 1 MB private 8-way, ~12 cyc latency. Stretch: 2 MB on highest-clock big core.
- Mid: 512 KB - 1 MB private 8-way.
- Little: 256 KB private 4-way.
- Hardware page-table walker shared with L2 (Sv48 mandatory, Sv57 capable).
- L2 prefetcher: Best-Offset + SPP, mirroring XiangShan CoupledL2 + SPP feedback.

### C.3 Cluster L3 (DSU-class)

- 8 MB shared 16-way, mostly-inclusive of L2, 64 B line, ~25 cyc.
- 16 MB stretch matches Dimensity 9500 / Exynos 2600.
- Replacement: Mockingjay (preferred) or Hawkeye fallback. Mockingjay area cost ~7-9% over LRU for 15.2% IPC win on SPEC.
- Coherence point: where the on-die directory or snoop filter lives.

### C.4 SLC

- 16 MB MVP / 32 MB stretch, 16-way, 64-128 B line, ~50 cyc CPU-side.
- Multi-bank (4-8 banks) with per-bank arbiters and per-client QoS (CPU, NPU, GPU, ISP/camera, display, DMA). Display gets guaranteed-bandwidth class.
- Way-partitioning / way-locking for NPU tensor working sets and display line buffers (CMN-700 style).
- DVFS-aware way shutoff.
- Mockingjay/Hawkeye with temporal hint bits from clients (NPU streaming → "no-allocate" or "RRIP-distant").
- BDI compression on SLC lines only (~1.5× effective capacity, <1-cycle decompress). Skip L1/L2 compression.

### C.5 Coherence protocol and fabric

- Protocol: MOESI on CPU/L2/L3 (handles dirty-shared with NPU/GPU); plain MESI acceptable MVP (TileLink TL-C native).
- Fabric: TileLink TL-C at L2-to-L3 (matches Chipyard, BOOM, Rocket, XiangShan CoupledL2). CHI-style bridge at L3-to-SLC and SLC-to-DRAM.
- Directory: distributed at L3 (snoop filter per slice), full inclusion of L2 tags.
- IO-coherent NPU and GPU: writes hit directory, no software cache maintenance for AI tensor handoff. ISP/camera/DMA non-coherent with explicit clean/invalidate ABI (Linux dma-buf attach/detach).

### C.6 Topology

- 1 × Ultra big core (3.6-4.0 GHz): 2 MB private L2.
- 3 × Premium big cores (3.2-3.4 GHz): 1 MB private L2 each.
- 4 × Pro little cores (2.4-2.6 GHz): 512 KB private L2 each.
- Shared L3: 8 MB MVP / 16 MB stretch.
- SLC: 16 MB MVP / 32 MB stretch.
- Total on-die: ~31 MB MVP / ~55 MB stretch.

## D. Benchmarks / eval / testing

### D.1 Microarchitecture sweeps (pre-silicon)

| Tool | Use |
|---|---|
| ChampSim | Prefetcher (IPCP, Bingo, SPP, Berti, Pythia, SPPAM) and replacement (LRU, DRRIP, Hawkeye, Mockingjay) sweeps on DPC-3 and SPEC CPU 2017 + GAP traces |
| gem5 RISC-V O3 | End-to-end IPC and miss-rate, full system, TLB and page-walk |
| XiangShan emu | Cross-check L1/L2 vs open RISC-V baseline (CoupledL2 + BOP) |
| CoMeT / Sniper | Mobile multi-program contention sweeps for SLC partitioning |

### D.2 Lat/BW microbenchmarks

- **lmbench `lat_mem_rd`** stride-walking pointer chase — canonical L1/L2/L3/SLC/DRAM latency curve.
- **STREAM** (Triad, Copy, Add, Scale) — sustained BW. Target ≥120 GB/s sustained / ≥180 stretch.
- **lmbench `bw_mem`** — single-thread BW per cache level.
- **TinyMemBench / pointer-chase variants** — SLC and DRAM tail latency.

### D.3 Android-workload validation

- `perf c2c` — cache-to-cache transfers, false/true sharing on coherence fabric.
- `perf mem` — load latency histograms, MPKI by source level.
- `simpleperf` (Android) — same counters under realistic AOSP workloads.
- MLPerf Mobile + AI Benchmark v6+ — NPU↔CPU↔SLC↔DRAM path.
- Camera+display concurrency: ISP write stream + display read stream + CPU workload concurrently; measure display underflow count and CPU 99p latency. This is the "SLC justifies its area" test.

### D.4 Comparison methodology

- David Huang / TechInsights latency curves on Apple A-series and M-series.
- Chips and Cheese Snapdragon X / X2 Elite and Cortex-X925 deep dives.
- Anandtech legacy memory subsystem teardowns.
- WikiChip Fuse for Arm DSU and CMN.
- AnandTech Tensor G1 is the only mobile SLC piece with full lmbench traces — use as methodology template.

Publish lmbench `lat_mem_rd` curves at five working-set points (1 KB, 64 KB, 1 MB, 16 MB, 256 MB), at three frequency points (idle, nominal, max), with explicit thermal state. Do not publish raw IPC vs Apple; publish per-MPKI normalized comparisons.

### D.5 RTL / sim CI gates

- `make cache-hierarchy-claim-gate` — RTL exists at each level.
- `make cocotb-cache-coherence` — TL-C / CHI coherence vectors.
- `make champsim-prefetch-sweep` — DPC-3 sweep of upstream-bundled
  prefetchers plus in-tree Berti, IPCP, Bingo, BOP, and Pythia-scoped ports.
  evidence_class=champsim_dpc3_traces_only; phone-class and full-system claims
  remain blocked.
- `make mockingjay-vs-lru-sweep` — DPC-3 LRU baseline + bundled
  replacement deltas (lru/drrip/ship/srrip) plus Hawkeye / Mockingjay-prod
  scoped evidence. evidence_class=champsim_dpc3_traces_only.
- `make cocotb-cache-mockingjay-accuracy` — Mockingjay-prod RTL vs LRU
  oracle on synthetic scan+reuse stream.

## E. Optimizations: has / should / needs

### Has
- L1/L2/SLC cache hierarchy RTL, TL-C / CHI bridge, BDI compression, prefetcher
  candidates, and replacement-policy RTL exist with scoped gates. Current
  evidence is RTL/simulation and DPC-3 scoped; phone-class latency/coherency
  and Linux/Android workload evidence remain blocked.

### Should (high-confidence 2028 must-haves)
1. Real L1I and L1D in every core, 64 KB / 8-way, parity (L1I) and ECC (L1D, SECDED).
2. Private per-core L2 ≥ 1 MB on big cores.
3. Shared L3 ≥ 8 MB with directory-based MESI.
4. SLC ≥ 16 MB multi-bank with per-client QoS.
5. FDIP with ≥8K BTB.
6. Berti L1D prefetcher — best published cost/perf in 2025 RTL.
7. Mockingjay LLC at L3 and/or SLC. Hawkeye fallback.
8. TileLink TL-C L2-to-L3 + CHI bridge at SLC.
9. IOMMU/SMMU in front of every non-CPU master with IO-coherent NPU and GPU.
10. Multi-page-size TLBs (4 KB / 2 MB / 1 GB), shared L2 TLB with parallel HW page-table walk. Sv48 mandatory.

### Definitely needs (lower-confidence, worth prototyping)
- BDI cache compression at SLC only.
- Pythia experimental path next to Berti. RL prefetcher has clean RTL ref impl from CMU-SAFARI; A/B test on same SoC.
- Way-shutoff DVFS on SLC banks (per-bank power gating).
- SLC partitioning per client class.
- Cache stashing for NPU (writes destined for CPU stashed in L3/SLC instead of DRAM, ~3-7% on producer-consumer AI pipelines).
- CXL.cache-style coherent NPU: future-compatible drop-in.

### Should NOT do
- Apple-style 192 KB L1I on the big core — not justified at open RISC-V area budget.
- Single huge L2 shared across all CPUs like Apple's 16 MB P-cluster — directory + snoop filter cost is enormous.
- L1 compression — latency tax wipes out capacity win.
- Inclusive LLC — Mockingjay and modern designs prefer mostly-inclusive or non-inclusive.

## F. Risks and open questions

1. **Open RTL for Mockingjay and Berti is academic-quality**. Mockingjay has ChampSim reference, not fab-ready RTL. Budget 6-9 person-months for productization.
2. **Directory + snoop filter sizing is the hardest correctness issue**. Sweep in gem5 / XiangShan emu before freezing.
3. **CHI vs TileLink boundary**. TileLink natural for Chipyard / BOOM / Rocket. CHI for Arm CMN-S3 and Synopsys/Cadence verification IP. Recommend TileLink TL-C inside cluster, CHI at SLC ↔ DRAM boundary.
4. **NPU coherency contract** open in `docs/project/uma-coherency-validation-strategy.yaml`. IO-coherent vs non-coherent + explicit cache maintenance. Recommend IO-coherent for clean dma-buf story.
5. **SLC bandwidth on an open process** — Apple gets 32 MB SLC at very low latency because they own N3 layout. Open project will pay ~10-15 cycles extra at SLC vs Apple.
6. **DRAM controller still missing** — SLC's job is to hide DRAM latency.
7. **Verification cost of MOESI vs MESI** — MOESI buys 5-15% BW savings on producer-consumer but increases protocol state ~40%. MESI MVP recommended.
8. **Pythia RL training data on Android** — workload-sensitive. Phone (camera burst, launcher swipe, LLM token-gen) very different from SPEC. Train/tune Pythia for mobile separately.
9. **Side channels** — EXAM (USENIX 2025) showed Apple's exclusive-partition SLC is itself a side-channel surface.
10. **Process derating** — `docs/spec-db/process-14a-effects.yaml` SS corner pushes L1/L2 cycle time up. Allocate guard cycles.

## Sources

- [Snapdragon 8 Elite Gen 5 cache (nanoreview)](https://nanoreview.net/en/soc/qualcomm-snapdragon-8-elite-2)
- [Snapdragon X2 Elite deep dive (Chips and Cheese)](https://chipsandcheese.com/p/qualcomms-snapdragon-x2-elite)
- [Snapdragon 8 Elite Oryon + SLC (Android Authority)](https://www.androidauthority.com/snapdragon-8-elite-deep-dive-3491526/)
- [MediaTek Dimensity 9500](https://www.mediatek.com/products/smartphones/mediatek-dimensity-9500)
- [Dimensity 9500 cache breakdown](https://x.com/yabhishekhd/status/1970062227056271568)
- [Apple A19 Pro vs A19 (wccftech)](https://wccftech.com/a19-pro-vs-a19-in-depth-specifications-differences-table/)
- [Apple M5 cache (Creative Strategies)](https://creativestrategies.com/research/m5-apple-silicon-its-all-about-the-cache-and-tensors/)
- [Apple M1 cache (7-cpu.com)](https://www.7-cpu.com/cpu/Apple_M1.html)
- [EXAM: Apple M-series SLC partition (arXiv)](https://arxiv.org/html/2504.13385v1)
- [Cortex-X925 (Chips and Cheese)](https://chipsandcheese.com/p/arms-cortex-x925-reaching-desktop)
- [Cortex-X925 TRM](https://developer.arm.com/documentation/102807/0001/The-Cortex-X925--core/Cortex-X925--core-features)
- [Samsung Exynos 2600 (nanoreview)](https://nanoreview.net/en/soc/samsung-exynos-2600)
- [Google Tensor G5 (nanoreview)](https://nanoreview.net/en/soc/google-tensor-g5)
- [Google Tensor memory subsystem (AnandTech)](https://www.anandtech.com/show/17032/tensor-soc-performance-efficiency/2)
- [Arm CMN-700 overview](https://armkeil.blob.core.windows.net/developer/Files/pdf/solution_overview-corelink-cmn-700.pdf)
- [TileLink Spec 1.8.1](https://starfivetech.com/uploads/tilelink_spec_1.8.1.pdf)
- [XiangShan Hot Chips 2024 (STH)](https://www.servethehome.com/xiangshan-high-performance-risc-v-processors-at-hot-chips-2024/)
- [XiangShan CoupledL2](https://docs.xiangshan.cc/projects/design/en/latest/cache/l2cache/CoupledL2/)
- [Pythia (MICRO 2021)](https://people.inf.ethz.ch/omutlu/pub/Pythia-customizable-hardware-prefetcher-using-reinforcement-learning_micro21.pdf)
- [Pythia ref impl](https://github.com/CMU-SAFARI/Pythia)
- [Berti (MICRO 2022)](https://dl.acm.org/doi/10.1109/MICRO56248.2022.00072)
- [SPPAM (arXiv 2026)](https://arxiv.org/html/2602.04100)
- [Mockingjay (HPCA 2022)](https://www.cs.utexas.edu/~lin/papers/hpca22.pdf)
- [Hawkeye](https://www.semanticscholar.org/paper/Hawkeye-:-Leveraging-Belady-%E2%80%99-s-Algorithm-for-Cache-Jain-Lin/0c163ad37386873ff0c06f224899122a79af14a6)
- [Drishti (MICRO 2025)](https://dl.acm.org/doi/full/10.1145/3725843.3756028)
- [FDIP Revisited (arXiv 2006.13547)](https://arxiv.org/abs/2006.13547)
- [PDIP (ASPLOS 2024)](https://cseweb.ucsd.edu//~tullsen/asplos24_pdip.pdf)
- [DEER (arXiv 2504.20387)](https://arxiv.org/html/2504.20387)
- [BDI compression (PACT 2012)](https://users.ece.cmu.edu/~omutlu/pub/bdi-compression_pact12.pdf)
- [BDI ref impl](https://github.com/CMU-SAFARI/BDICompression)
