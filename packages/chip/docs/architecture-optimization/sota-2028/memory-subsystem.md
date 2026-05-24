# Memory Subsystem SOTA — 2028 RISC-V Phone-Class AP

Sub-report of [2028-sota-integrated-report.md](../2028-sota-integrated-report.md).

## A. SOTA snapshot

### A.1 Memory technology

| Standard | Per-pin rate | Per-pin BW | Per 16-bit channel | Notes |
|---|---|---|---|---|
| LPDDR5 | 6.4 Gbps | 0.8 GB/s | 12.8 GB/s | JESD209-5 |
| LPDDR5X (5C) | up to 10.7 Gbps | 1.34 GB/s | 21.4 GB/s | JESD209-5C Jun 2023; link-ECC |
| LPDDR5T (Samsung) | 10.7 Gbps | 1.34 GB/s | 21.4 GB/s | Vendor brand |
| LPDDR6 (JESD209-6) | 10.667 - 14.4 Gbps | 1.8 GB/s @ 14.4 | ~21.6 GB/s per 12-bit half-channel | Jul 9 2025; reduced IO voltage; link-ECC + on-die ECC baseline |
| LPDDR6 stretch | 14.4 - 17 Gbps post-1.0 | up to 2.1 GB/s | — | Trendforce/Cadence roadmap |

LPDDR5X retains LPDDR5's "two 16-bit sub-channels per x32 die"; LPDDR6 switches to a 24-bit channel split into two 12-bit sub-channels, integrates link-ECC + on-die ECC as baseline. Samsung 10.7 Gbps LPDDR6 on 12 nm class announced Nov 2025 with ~21% energy efficiency uplift vs LPDDR5X.

### A.2 Named competitor SoCs

| SoC | DRAM | Bus | Peak BW | Capacity | SLC | IOMMU |
|---|---|---|---|---|---|---|
| Snapdragon 8 Elite Gen 5 | LPDDR5X-5300 | 4×16b = 64b | 84.8 GB/s | up to 24 GB | ~8 MiB SLC | Arm SMMU-700 |
| Snapdragon 8 Elite | LPDDR5X-9600 | 4×16b | ~76.8 GB/s | up to 24 GB | 8 MiB SLC | SMMU-700 |
| MediaTek Dimensity 9500 | LPDDR5X-10667 | 4×16b | ~85.3 GB/s | up to 16 GB | 10 MiB SLC + 16 MiB L3 | MediaTek MMU/SMMU |
| Apple A19 Pro | LPDDR5X-9600 | 4×16b | 75.8 - 76.8 GB/s | 12 GB | ~24 MiB SLC (third-party) | Apple UMA |
| Google Tensor G5 | LPDDR5X | 4×16b | ~68 GB/s class | 12-16 GB | undisclosed | Arm SMMU + Google IP |
| Xiaomi XRing O1 | LPDDR5T | 4×16b | ~85 GB/s class | flagship | undisclosed | unclear |

Every 2025-flagship Android-class AP runs a 64-bit total physical bus = 4 channels × 16-bit. Bandwidth uplift from Gen 5 vs Gen 4 and Dimensity 9500 (~85 GB/s) is driven entirely by data-rate (5300 → 9600/10667 MT/s) at fixed 64-bit width. Capacity uplift to 24 GB is from die density (32 Gb per die). SLCs sit between 8 and ~24 MiB.

### A.3 IP layer

| Layer | Open / Closed | Notes |
|---|---|---|
| LPDDR5X PHY (10.67 Gbps) | Closed: Synopsys DWC_LPDDR5X54X, Cadence LPDDR5X/4X, Rambus | Synopsys rated 8533-10667 Mbps; LPDDR6/5X PHY at 14.4 Gbps |
| LPDDR6 PHY (14.4 Gbps) | Closed: Cadence tape-out July 2025 (industry-first), Synopsys at 14.4 Gbps | Cadence: PHY with DFE/FFE/CTLE, DFI 5.0 controller |
| LPDDR controller open IP | LiteDRAM (LPDDR4 PHY by Antmicro 2020) | No production LPDDR5/5X/6 open PHY. CHIPS Alliance + Google Rowhammer test framework piggy-backs on LiteDRAM |
| RISC-V IOMMU | Ratified v1.0.1, 2024-09-11 | Per-device DC, PASID, page-request, fault queue, DTF bit; QEMU emulation merged 2024; Linux RISC-V IOMMU driver in -next |
| Arm SMMUv3.x | SMMUv3.4 in Armv9 | Mature Linux iommu/arm-smmu-v3 driver; SVA + I/O page-fault upstream since v5.3-5.5 |
| Coherent fabric | Arm CMN-S3 / CMN-700 (AMBA 5 CHI), TileLink-C, AXI4 + ACE | CMN-S3 is Arm's current Neoverse / mobile-server mesh; native AMBA-5 CHI |
| Display compression | AFBC (Arm), AFRC (random-access), ASTC | AFBC lossless, 50% BW reduction between GPU/VPU/DPU |

## B. Current state in `packages/chip`

Repo-grounded:

- `rtl/memory/e1_axi_lite_dram.sv`: 1024 × 32-bit SRAM, single-beat AXI-Lite, one outstanding write + read, OKAY/SLVERR only, no bursts.
- `rtl/interconnect/e1_axi_lite_interconnect.sv` and `e1_linux_soc_contract.sv`: AXI-Lite 3-master (CPU / DMA / debug), fixed CPU-priority arbiter, 4 outstanding per master, 1024-cycle watchdog, decode-err sticky reg, single 256 MiB aperture at `0x8000_0000` but only 4 KiB implemented. No bursts. No IDs. No cache attributes. No coherency. No atomics. No QoS regs.
- `docs/arch/memory-subsystem.md` + `docs/evidence/memory/uma-dram-evidence-gate.yaml`: explicit fail-closed. Phase0 (4 KiB SRAM containment) current; phase1 (counters), phase2 (burst fabric), phase3 (UMA), phase4 (IOMMU), phase5 (LPDDR target) blocked.
- Chipyard generated AP gives SimDRAM at `0x8000_0000` / 256 MiB; Verilator behavioural model, not controller/PHY.
- `docs/arch/interconnect.md` notes "not AXI4, not TileLink, not CHI, not ACE".
- `docs/spec-db/process-14a-effects.yaml` calls out `14a_sram_macro_vmin_ecc_evidence_missing`.
- `docs/architecture-optimization/soc-optimized-operating-point.yaml`: keeps a 240 GB/s sustained DRAM operating-point target. `docs/evidence/memory/uma-dram-evidence-gate.yaml` reconciles that with a stricter phone profile and split LPDDR5X baseline / LPDDR6 AI SKUs; real phone bandwidth claims remain blocked until target measurements exist.

Bottom line: the phone-class memory stack remains blocked from a silicon
standpoint. The repo now has local RTL/cocotb evidence for pieces of the cache
hierarchy, a DRAM-controller simulation path, and a partial IOMMU subset, but
there is still no LPDDR PHY, no real DRAM capacity/timing evidence, no complete
coherent phone fabric, no full Linux IOMMU isolation, no phone QoS signoff, and
no measurement target.

## C. Recommended 2028 target

### C.1 External memory

| Parameter | Minimum (must-ship) | Stretch (AI SKU) |
|---|---|---|
| Standard | LPDDR5X-10667 (JESD209-5C) | LPDDR6-14400 (JESD209-6) |
| Bus width at PHY | 4 ch × 16-bit = 64-bit (8 sub-ch × 8 byte-lanes) | 4 ch × 24-bit = 96-bit logical (8 sub-ch × 12-bit LPDDR6) |
| Peak bandwidth | 85.3 GB/s | 172.8 GB/s |
| Sustained target | ≥70 GB/s (~82% peak with display+camera+NPU contention) | ≥140 GB/s sustained |
| Capacity SKUs | 12 GiB (entry), 16 GiB (mid) | 24 GiB (AI) using 32 Gb dies ×4 |
| ECC | Mandatory on-die (LPDDR5X+) + link-ECC enabled | Plus optional inline parity for TEE/security regions |
| Refresh | Per-bank refresh; fine-grained tRFCab/tRFCpb knobs | Plus temperature-compensated refresh (TCSR) |
| Training | Full read/write leveling, gate training, vref, periodic ZQ cal | Plus per-byte-lane DFE/FFE training (LPDDR6) |

The 120 GB/s sustained target requires the stretch SKU; LPDDR5X-10667 at 64-bit caps at 85.3 GB/s peak. The tracked 96-bit LPDDR6-14400 AI SKU reaches 172.8 GB/s peak, so it must be recorded as a peak-gate downgrade against the 180 GB/s phone profile unless the target profile changes or the bus widens to 128-bit (M-series / AI-PC territory, breaks phone power budget). Recommend split SKUs: baseline LPDDR5X 70 GB/s sustained; AI SKU LPDDR6 140 GB/s sustained with explicit peak-gate downgrade semantics.

### C.2 PHY / controller IP path

Hardest open RISC-V question. No open LPDDR5X/6 PHY today. LiteDRAM tops out at LPDDR4.

1. License **Synopsys DWC LPDDR6/5X PHY + secure controller** (DFI 5.0, up to 14.4 Gbps).
2. License **Cadence LPDDR6/5X PHY + controller** (tape-out July 2025, industry-first 14.4 Gbps).
3. License **Rambus LPDDR5X PHY** at 10.67 Gbps tier; LPDDR6 TBA.
4. **Foundry-supplied PHY** bundled with 14A/N3/N2 PDK kit.
5. **Co-development with CHIPS Alliance LiteDRAM + LPDDR5 PHY** — research only, not production.

Non-negotiable IP buy. The repo's `docs/spec-db/mobile-sota-2026.yaml` calls "custom LPDDR5X/LPDDR6 PHY" an explicit non-goal — promote to procurement gate.

### C.3 SoC fabric and SLC

| Block | Recommendation | Why |
|---|---|---|
| CPU↔LLC↔SLC fabric | AMBA-5 CHI (Arm CMN-S3 class) or open TileLink-C | CHI production standard; TileLink-C open path (SiFive/BOOM/Rocket). CHI faster; TileLink-C consistent with open story |
| NPU/GPU/ISP fabric | AXI4 with ACE-Lite (IO-coherent) into SLC | Avoids full snoop-in for read-many-write-rarely accelerator traffic |
| Display + camera VC | Dedicated VC / QoS class on NoC, latency-sensitive priority | Display underflow hard real-time |
| SLC size | 24 MiB (must-ship) / 32 MiB (AI SKU) | Matches A19 Pro / above D9500 (10 MiB) and S8E (8 MiB). At 14A/N2 SRAM density (~38 Mb/mm² N2 GAA) → 32 MiB ~0.7-1.0 mm² |
| SLC partitioning | Per-master way-allocation + pseudo-LRU + stash hints | NPU and camera benefit from explicit stash; CPU benefits from way-partition isolation |
| NoC topology | 2D-mesh CMN-S3-class, 4-6 home nodes, 2 memory home nodes | Matches LPDDR memory-controller count |
| Coherency directives | I/O-coherent DMA + NPU read paths; non-coherent + cache-maintenance for video/display writes | Hybrid is what Snapdragon/Dimensity actually do |

### C.4 IOMMU / SMMU

| Decision | Recommendation |
|---|---|
| Spec | RISC-V IOMMU v1.0.1 ratified (Sep 2024) for RISC-V-native path; SMMUv3.4-equivalent feature set required |
| Page-table format | Sv39 + Sv48 (4-level) compatible with RISC-V MMU; G-stage for virtualization |
| Streams | Per-device DC with PASID; IDs for NPU command-queue contexts, display planes, camera ISP pipelines, GPU contexts, DMA channels |
| Fault reporting | Fault queue with master/stream ID, IOVA, fault type, syndrome, PASID, page-request interface for SVA |
| Linux integration | RISC-V IOMMU driver in -next; Android requires dma-buf/iommu-v2 mapping ABI |
| Risk | Linux RISC-V IOMMU + QEMU still maturing (v6.x kernels). Plan upstream churn through 2026-2027 |

### C.5 ECC, refresh, training, reliability

- On-die ECC mandatory (LPDDR5X+ enforces).
- Link-ECC enabled in controller; counters via Linux EDAC.
- Per-bank refresh with PBR scheduler prioritizing idle banks.
- Temperature-compensated refresh from SoC thermal sensors.
- Patrol scrub for TEE, keyslots.
- MBIST + repair fuses for on-die SRAM, consistent with `14a_sram_macro_vmin_ecc_evidence_missing` blocker.

## D. Benchmarks, evaluation, testing

### D.1 Mandatory measurement matrix

| Metric | Tool | Pass threshold | Notes |
|---|---|---|---|
| Peak read BW | `STREAM` (Copy/Scale/Add/Triad) | ≥85% theoretical peak | `-O3 -fopenmp`; pin threads |
| Latency to DRAM | `lmbench lat_mem_rd` | ≤120 ns p95 random-read | Stride > LLC; defeat prefetch with random walk |
| Pointer-chase | lmbench random | curve L1 → L2 → L3 → SLC → DRAM | Plot working-set vs latency; verify each level |
| Sustained BW | `bw_mem` rd/wr/rdwr/cp/bzero | ≥120 GB/s stretch / ≥70 baseline | Multi-thread, per-channel NUMA-pinned |
| Mixed access | `mlc` (Intel) port or open equivalent | latency curve under BW load | Build using `lmbench bw_mem` + `lat_mem_rd` concurrently |
| Contended IO | `fio` random + sequential vs UFS while STREAM | UFS BW degrade ≤15% under DRAM saturation | UFS 4.x and DRAM share controller-side QoS |
| MLPerf Mobile | TFLite/ExecuTorch — MobileBERT, MobileNet, DeepLabv3, SSD, SD-XL (v6.0 added LLM/diffusion) | end-to-end latency + samples/s + thermal | MLPerf Inference v6.0 ran April 2026; single-stream + offline |
| Contended quad | NPU command queue + AFBC display 120 Hz QHD + camera ISP sim + dhrystone | display underflow 0; NPU TOPS drop ≤10%; CPU p99 bounded | Killer test; display underflow gate already named |
| Stale-buffer negative | dma-buf producer forgets cache-clean → consumer detects | must fault or be statically forbidden | Required by uma-coherency-validation-strategy |
| IOMMU fault | program unauthorized IOVA from NPU/DMA → expect fault queue entry | fault entry has master, IOVA, access, syndrome | Required by RISC-V IOMMU spec |

### D.2 Comparison data sources

| Competitor | Best public number | Source |
|---|---|---|
| Snapdragon 8 Elite Gen 5 | 84.8 GB/s peak | Notebookcheck; Qualcomm product brief |
| Snapdragon 8 Elite | ~76.8 GB/s | Notebookcheck; chipsandcheese X2 Elite |
| Apple A19 Pro | 75.8-76.8 GB/s; latency ~115 ns | Notebookcheck; AppleWiki; chipsandcheese A17/A18 |
| Dimensity 9500 | ~85.3 GB/s peak; 10 MiB SLC + 16 MiB L3 | MediaTek; innoGyan |
| Tensor G5 | ~68 GB/s class | Android Central |

Use chipsandcheese latency curves and Anandtech BW plots as the public comparator.

## E. Optimizations

### Already present
- Address decode containment for DMA.
- CPU-priority arbitration with negative test for DMA over MMIO.
- AXI-Lite watchdog and decode-err sticky reg.
- Verilator SimDRAM at `0x8000_0000` / 256 MiB from Chipyard.

### Required before 2028 phone-class claim
| Category | Optimization | Why |
|---|---|---|
| PHY | Synopsys/Cadence LPDDR6/5X PHY at 14.4/10.67 Gbps with DFE/FFE/CTLE | Cannot self-design at this rate |
| Controller | Per-channel reorder queue, write-combining, refresh scheduler with PBR, page-policy heuristics, ZQ cal, on-die ECC + link-ECC | Memory controller table-stakes |
| Bus | AXI4 with bursts, IDs, exclusive monitors, ACE-Lite + CHI bridge | Required for SLC attach |
| SLC | 24-32 MiB, way-partitioned, stash-on-write hints from NPU/camera | Hides LPDDR latency from NPU bursts |
| NoC | CMN-S3-class or TileLink-C mesh with 2 memory home nodes per channel | Avoids single arbiter bottleneck |
| QoS | 4-class scheduler: display(RT) > camera > CPU > NPU > GPU > DMA-bulk; per-master BW meters; latency targets | Display underflow zero at 120/144 Hz QHD |
| IOMMU | RISC-V IOMMU v1.0.1 with G-stage, PASID, page-request, fault queue, ATS | Required by Android dma-buf + secure HAL |
| AFBC | AFBC 1.x or 2.0 on display + GPU + VPU | -50% display BW, free 30 GB/s headroom |
| NPU activation compression | Lossless tile-based on activations between L2 SRAM and DRAM | Mirrors MediaTek/Apple |
| Refresh | Per-bank refresh + temperature-compensated | -8% to -20% latency overhead recovery |
| Counters | Per-master read/write/error/latency-histogram via Linux EDAC + perf | Required by gate |
| ECC | On-die + link-ECC always-on, EDAC events to user-space, optional inline ECC for TEE | LPDDR5+ assumes this |

### Optional but high-value
- SLC compression (Apple-style cache-line compression).
- Stash-on-write with explicit `CACHE_PRELOAD` hints from NPU compiler.
- Memory-side bloom filter for dirty tracking.
- Companion 64 MiB on-die SRAM tier for NPU activations.

## F. Risks and open questions

1. **No open LPDDR5X/6 PHY**. Must license Synopsys/Cadence/Rambus or take foundry-bundled PHY. Promote in `mobile-sota-2026.yaml` from non-goal to procurement requirement.
2. **PHY cost and area**: 64-bit LPDDR5X PHY at 10.67 Gbps on N3/N2 ~5-7 mm²; license mid-7-figures + royalty. LPDDR6 14.4 Gbps more area for DFE/FFE.
3. **RISC-V IOMMU maturity**: spec ratified Sep 2024, Linux driver merged ~v6.10-6.12, QEMU base 2024. No shipping Android phone with RISC-V IOMMU + tested HAL. Plan multi-quarter contributor work on Android IOMMU bindings, dma-buf v2, gralloc, NN HAL.
4. **Memory target split remains evidence-gated**: `uma-dram-evidence-gate.yaml` records the 120 GB/s sustained / 180 GB/s peak phone profile and split LPDDR5X baseline / LPDDR6 AI SKUs, while `soc-optimized-operating-point.yaml` keeps the aspirational 240 GB/s operating point. LPDDR measurements are still required before any phone-class memory claim is promoted.
5. **SRAM-wall on 14A**: N3 only ~5% SRAM density vs N5. N2 ~17% recovery via nanosheets (38 Mb/mm² macro). Plan SLC twice — N2-class (24-32 MiB), 14A-class (assume similar).

## Recommended next steps

1. Promote "custom LPDDR5X/LPDDR6 PHY" to procurement decision in `mobile-sota-2026.yaml`.
2. Keep `soc-optimized-operating-point.yaml` (240 GB/s operating point) and `uma-dram-evidence-gate.yaml` (120/180 profile plus split SKUs) synchronized as target measurements arrive.
3. Add phase1.5 to `memory_roadmap_phases`: burst-capable scaffold with AXI4 IDs + outstanding counters before coherency jump.
4. Pull RISC-V IOMMU reference model (`riscv-non-isa/riscv-iommu`) under `verify/external/`.
5. Define LPDDR PHY attach contract via DFI 5.0 boundary signals as controller's "south" interface (Synopsys + Cadence both speak DFI 5.0).
6. Define dma-buf v2 + RISC-V IOMMU + AFBC Android stack as separate work order with its own evidence gate.
7. Plan SLC sizing twice (N2 and 14A) under `process-14a-effects.yaml`. Capture SRAM-wall with N3/N5/N2 bitcell numbers.
8. Build LPDDR-aware bandwidth/latency simulator (wrap DRAMSim3 or Ramulator2) under `compiler/runtime/`. Mark all results simulator-only.

## Sources

- JEDEC JESD209-5C, Jun 2023 — https://www.jedec.org/standards-documents/docs/jesd209-5c
- JEDEC LPDDR6 (JESD209-6) press release, 9 Jul 2025 — https://www.jedec.org/news/pressreleases/jedec-releases-new-lpddr6-standard-enhance-mobile-and-ai-memory-performance
- Notebookcheck LPDDR6 14.4 MT/s — https://www.notebookcheck.net/JEDEC-releases-LPDDR6-standard-data-rates-reach-14-400-MT-s.1055771.0.html
- Trendforce Samsung LPDDR6 — https://www.trendforce.com/news/2025/11/10/news-samsung-lpddr6-memory-specs-unveiled-10-7gbps-speed-on-12nm-reportedly-eyes-14-gbps/
- Cadence LPDDR6/5X PHY Jul 2025 — https://www.cadence.com/en_US/home/company/newsroom/press-releases/pr/2025/cadence-introduces-industry-first-lpddr65x-144gbps-memory-ip-to.html
- Synopsys LPDDR6/5X/5 PHY IP — https://www.synopsys.com/designware-ip/interface-ip/ddr/lpddr65x5-phy.html
- Synopsys LPDDR5X/5/4X PHY IP — https://www.synopsys.com/designware-ip/interface-ip/ddr/lpddr5x54x-phy.html
- Qualcomm Snapdragon 8 Elite Gen 5 product brief — https://www.qualcomm.com/content/dam/qcomm-martech/dm-assets/documents/Snapdragon-8-Elite-Gen-5-product-brief.pdf
- MediaTek Dimensity 9500 — https://www.mediatek.com/products/smartphones/mediatek-dimensity-9500
- Dimensity 9500 cache (innoGyan) — https://innogyan.in/2025/06/13/mediatek-dimensity-9500-detailed-specs-and-benchmarks-revealed/
- RISC-V IOMMU v1.0.1 ratified — https://docs.riscv.org/reference/hardware/iommu/v20240911/_attachments/riscv-iommu.pdf
- RISC-V IOMMU GitHub — https://github.com/riscv-non-isa/riscv-iommu
- Linux RISC-V IOMMU LWN — https://lwn.net/Articles/972035/
- Arm CMN-S3 — https://www.arm.com/products/silicon-ip-system/neoverse-interconnect/cmn-s3
- Arm AFBC — https://www.arm.com/technologies/graphics-technologies/arm-frame-buffer-compression
- TSMC SRAM scaling N3 vs N5 vs N2 — https://www.tomshardware.com/tech-industry/sram-scaling-isnt-dead-after-all-tsmcs-2nm-process-tech-claims-major-improvements
- LiteDRAM — https://github.com/enjoy-digital/litedram
- DDR refresh per-bank (Mutlu HPCA'14) — https://users.ece.cmu.edu/~omutlu/pub/dram-access-refresh-parallelization_hpca14.pdf
- SiFive TileLink 1.8.1 — https://starfivetech.com/uploads/tilelink_spec_1.8.1.pdf
- MLPerf Mobile — https://mlcommons.org/benchmarks/inference-mobile/
