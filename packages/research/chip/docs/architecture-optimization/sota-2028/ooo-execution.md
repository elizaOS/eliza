# OoO Execution SOTA — 2028 RISC-V Phone-Class AP

Sub-report of [2028-sota-integrated-report.md](../2028-sota-integrated-report.md).

## A. SOTA Snapshot — Comparative uarch table (2024-2026 flagships)

Numbers are public/disclosed where vendors provided them and reverse-engineered (chipsandcheese, Dougall Johnson, WikiChip Fuse, jia.je/cpu) elsewhere. "FE" = front-end.

| Core | ISA | FE fetch / decode | Dispatch / Retire | ROB / in-flight | PRF (INT / FP) | Int ALU | AGU / LSU | FP-Vec | Vector | Sched | L1I / L1D / L2 / SLC | Process | F_max | IPC SPEC2017 int | GB6 ST | Area / core (mm²) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Apple A19 Pro "Tahiti" (P) | ARMv9.5-A | 16B, ~9-wide | ~10-wide | ~700 ROB-eq | ~432 / ~432 (est) | 6+ | 4 | 4 | 128b NEON+SME2 | clustered ~6 | 192/128/16 MB / 8 MB SLC | TSMC N3P | 4.26 GHz | ~11-12 est | 3895 | ~2.0 |
| Qualcomm Oryon Gen 3 Prime | ARMv9.2-A | 16B, 9-wide | 9-wide | ~650 ROB | ~400 / ~400 | 6 (incl 2 br) | 3+ | 4 (256b VLEN agg) | 128b NEON | unified+dist | 192/96/12 MB / 16 MB SLC | TSMC N3P | 4.74 GHz | ~10.5 | 3649 | ~2.1 |
| Arm Cortex-X925 "Blackhawk" | ARMv9.2-A | 32B, 10-wide | 10-wide | ~525 effective (768 inflight + 1536 fused) | ~448 total | 8 ALU 4×28-sched, 3 br | 4 AGU (2 store) | 6 FP/SIMD (3×~53) | 128b NEON+SVE2 | dist 4 INT + 3 FP | 64/64/2-3 MB | TSMC N3E | 3.62-3.8 GHz | ~11.8 | 3000-3400 | ~1.7 |
| Arm C1-Ultra "Travis" | ARMv9.3-A | 32B, 10-wide refined | 10-wide | ~2000 in-flight | ~512+ | 8 ALU | 4 AGU | 6 FP/SIMD+SME2 | 128b NEON+SVE2+SME2 | dist + SME sched | 64/64/3 MB / 16 MB SLC | TSMC N3P | 4.21 GHz | ~13.2 (Arm +25% vs X925) | 3502 | ~1.9 |
| AMD Zen 5 | x86-64 | 32B, dual 4-wide (=8) | 8-wide | 448 ROB | 240 INT / 384 FP (512b) | 6 ALU unified | 4 AGU | 4 FP (2× decoupled) + 1 store/FP-to-INT | 512b AVX-512 | unified INT, decoupled FP | 32/48/1 MB / 32 MB L3 | TSMC N4P | 5.7 GHz | ~12 | 3400 (9950X) | ~3.6 (incl L2) |
| Intel Lion Cove (Lunar Lake) | x86-64 | 32B, 8-wide (µop 12-wide) | 8-wide, HT removed | ~576 ROB | INT/FP/VEC files deeper | 6 ALU | 4 AGU (3 ld + 2 st overlap) | 4 vector (2×128 + 2×256) | 256b AVX2 (no AVX-512 on LL) | split 144 INT (6 ports) + 96 vector (5 ports) | 64/48/2.5-3 MB / 8 MB | TSMC N3B | 5.1 GHz | ~12.5 | 2900-3100 | ~4.5 |
| Tenstorrent Ascalon-D8 | RVA23 | 16B, 8-wide | 8-wide | ~450-500 ROB (est) | ~400 / ~400 | 6 INT (2 br) | 3 LSU | 2 FP + 2×256-bit RVV | 256b RVV 1.0 | ~6-queue dist | 64/64/1-2 MB | N3/N5 IP | ~3.2 GHz target | ~21 SPECint2006/GHz ≈ 9-10 IPC SPEC2017 | n/a | ~1.8 IP |
| SiFive P870 | RVA23 (V) | 16B, 6-wide | 6-wide | ~1120 inflight | ~256 / 128 V renames | 5 INT + 1 br-cap | 2-3 LSU | 2 FP/V w/ V sequencer | 128b RVV 1.0 | 4-queue dist | 64/64/1 MB | N7/N5 IP | ~3.0 GHz | ~13.5 SPECint2006/GHz ≈ 6.5 IPC SPEC2017 | n/a | ~1.2 IP |
| XiangShan Kunminghu V3 | RV64GC + V | 16B, 6-wide | 6-wide | ~256-320 ROB | ~192 / ~192 | 4 ALU + 2 br | 2-3 LSU | 2 FP + 2 V | 128b RVV 1.0 | dist | 64/64/1 MB | 7/12/28 nm | ~3.0 GHz sim | >15 pt/GHz target → 20 (~7-9 IPC SPEC2017) | Neoverse-N2 -8% claim | ~1.5 (12 nm) |
| Ventana Veyron V2 | RV64GC+V | 16B, 8-wide (fusion magnifies) | up to 15 internal ops/clock with fusion | ~480+ ROB | ~384 / 256 | 6+ INT | 4 LSU | 2-4 FP/V | 256-512b RVV config | dist | 64/64/2 MB | TSMC N4/N3 | ~3.6 GHz | ~17 SPECint2006/GHz ≈ 8 IPC SPEC2017 | n/a (datacenter) | ~2.2 |
| MIPS P8700 | RV64GC | 8B fetch, 4-wide | 4-wide | ~96 ROB | smaller | 4 ALU | 2 LSU | 2 FP | 128b | dist | 64/64/256 KB-2 MB | 7/16 nm | ~2.5 GHz | ~6 IPC SPEC2017 est | n/a | ~0.9 |
| BOOM v3 / SonicBOOM | RV64GC | 4-8 wide param | 2-4-wide typical | 32-256 ROB param | 64-128 / 64-128 | 1-4 ALU | 1-2 LSU | 1-2 FP | optional | dist | param | acad/FPGA | ~1.5-2.5 GHz ASIC est | 6.2 CoreMark/MHz → 3-5 IPC SPEC2017 | n/a | param |
| AMD Strix Point Zen 5c | x86-64 | 32B, 8-wide | 8-wide | 448 ROB | 240/384 | 6 | 4 | 4 FP | 256b AVX-512 native | unified | 32/48/1 MB / 24 MB | TSMC N4P | 5.1 GHz | ~11.5 | 2900 | ~2.8 |

Reference rows: D9500 (C1-Ultra 4.21 / Premium 3.5 / Pro 2.7 GHz), S8 Elite Gen 5 (Oryon Gen 3 Prime 4.6-4.74 / Perf 3.62 GHz), Tensor G5 (X4 3.78 / A725 3.05 / A520 2.25 GHz), Exynos 2600 (Samsung 2 nm GAA, GB6 ST 3197). Source: `docs/spec-db/mobile-sota-2026.yaml`.

## B. Current state in `packages/chip`

- `rtl/cpu/e1_cpu_subsystem_stub.sv` — tiny in-order RV64 fetch/execute: 32-bit AXI-Lite manager, 32 archregs as 64-bit, supports JAL/JALR/BEQ/BNE/LUI/AUIPC/ADDI/ADD/SUB/LW/SW, halts on ECALL/EBREAK/illegal/AXI error. Not Linux-capable. No CSR, privilege, MMU, traps, atomics, compressed, float, vector.
- `rtl/cpu/e1_cva6_wrapper.sv` — drop-in wrapper for OpenHW CVA6 (`ArianeDefaultConfig`, RV64IMAFDC + S-mode + Sv39), guarded by `+define+E1_HAVE_CVA6`. CVA6 = 6-stage single-issue in-order with limited speculation. Closest commercial peer: Cortex-A55-class. Expected SPEC2017 int IPC: ~1.5-1.8 on RTL, ~10× behind Cortex-X925.
- Chipyard Rocket (selected per `eliza-rocket-manifest.json`, commit `48f904ae`): 5-stage in-order, single-issue, RV64GC. SPEC2017 int IPC ~1.0-1.5.
- Modeled CPU planning point (`benchmarks/results/simulator-arch-metrics-sota.json`): 2-core, 3.8 GHz, modeled IPC 2.42, 2.76 W package. Architecture target only — `cpu_ap_evidence_blocked`.
- All flagship-class claims fail-closed blocked until `make cpu-ap-completion-gate`.

Gap to A19 Pro / Oryon Gen 3 / C1-Ultra:
- Decode width: 1 → 10 (10×)
- ROB: 0 → ~600-2000 (>500×)
- SPEC2017 IPC: ~1.0 → ~12 (~10×)
- ISA: RV64I subset → RVA23 + V + matrix
- Memory ordering: none → RVWMO+Ztso
- DVFS, big.LITTLE: none → 1+3+4

## C. Recommended 2028 target

### Big core ("e1-ultra"), 1 instance per cluster

| Parameter | Target | Rationale |
|---|---|---|
| ISA | RVA23 + V (RVV 1.0 VLEN=256) + Zfh/Zvfh + Zvbb/Zvkt + Zicboz/Zicbom + Ztso + Sv57 + Smaia (AIA) + Zihintpause + Zicond + Zama (matrix) | RVA23 mandated for Android RISC-V ABI; Ztso to run translated x86/ARM with single fence cost; Sv57 future-proofs >1 TB virtual; Ubuntu 25.10 mandates RVA23 |
| Front-end fetch | 32 B / cycle | RVC means up to 16 inst in 32 B; supports 10-wide decode |
| Decode | 8-wide native + 2 fused = 10 effective | Match X925/C1-Ultra; macro-op fusion recovers density loss vs ARM |
| L0 µop cache | 3 K entries, 12-wide read | Apple/Lion Cove style; bypasses decode for hot loops |
| Branch predictor | 16K-entry L1 BTB, 64K L2 BTB, TAGE-SC-L, 32-entry RAS, ITTAGE | Target contract: matches X925's 16K/2048+L2 class; <14-cycle mispredict recovery remains an implementation target until timing evidence exists. |
| Dispatch / Rename / Retire | 8 / 8 | PRF-based renaming (not ROB-based) for energy |
| ROB | 512 entries (~700 effective with fusion expansion) | Between X925 effective (~525) and Apple (~700) |
| PRF | 400 INT (64-bit) / 400 FP+V (256-bit) | Apple-class. Vector reg width 256b matches RVV DLEN=256 |
| Schedulers | Distributed: 4×32 INT, 2×48 FP/V, 2×40 LSU | Match X925 four-cluster; energy << unified at this width |
| Execution ports | 6 ALU (2 br), 2 IMUL/IDIV shared on ALU0/3, 4 FP/V, 4 AGU (2 ld + 2 st + 2 dual) | Match X925 (8 ALU, 4 AGU) but trim 6 ALU + 4 AGU |
| Load / Store queue | 192 LQ / 128 SQ | Apple-class; Oryon ~150/100. Store-set predictor for memory-disamb |
| Store-to-load forwarding | 4 simultaneous, partial-overlap | X925 explicitly improved; Zen 5 perfect-store forwarding |
| Vector unit | 2× 256-bit RVV 1.0 (DLEN=256, ELEN=64), Zvbb/Zvfh/Zvkt; future SME-like matrix tile via Zama | Matches Ascalon (2× 256b). X925 is 4× 128b NEON; equal effective BW |
| Matrix | Reserve area for RISC-V matrix when ratified; meanwhile expose via Zvqdotq/Zvfh and CSR-mapped tile regs | A19 Pro / C1-Ultra bet on SME2 INT8/BF16 tile units |
| Memory ordering | RVWMO native + Ztso mode selectable per-page (PTE bit) or per-thread | Ztso lets x86 binaries run without fence-spam, ~5-15% perf for translated |
| MMU | Sv48 default, Sv57 enabled; ASID 16-bit; 64 L1 ITLB + 64 L1 DTLB + 2048 L2 unified | Matches X925 (96/2048). Required for >32 GB phone RAM |
| Caches | 64 KB L1I (4-way) + 64 KB L1D (4-way, 4-cycle), private 1 MB L2 (12-cycle), shared 8 MB L3, 16 MB SLC | Matches X925 / D9500 |
| Clock | 4.0-4.3 GHz typical, 4.5 GHz burst | Below A19 Pro 4.26 to guard RVWMO+Ztso fence costs |
| IPC SPEC2017 target | ≥9 (≥ 22 SPECint2006/GHz, beating Ascalon's 21) | Achievable per Veyron V2 |
| Area (3 nm class) | ~1.8-2.0 mm² incl L2 | Tracks X925 (~1.7) |
| Power | 2.8 W burst, 1.4 W sustained | Matches `soc-optimized-operating-point.yaml` |

### Mid core ("e1-premium"), 3 instances

- Base: fork of XiangShan **Kunminghu V3** (open Mulan PSL v2)
- 6-wide decode, 6 dispatch, 256-entry ROB, 192/192 PRF
- 1× 128-bit RVV 1.0
- RVA23, no SME, RVWMO only
- 32 KB / 32 KB / 512 KB private L2
- 3.0-3.4 GHz
- IPC target ~5 (matches Kunminghu V3 "15 pt/GHz" current → "20 pt/GHz")
- Area ~0.7-0.9 mm²

### Little core ("e1-pro"), 4 instances

- Base: CVA6 (OpenHW, Solderpad) or Chipyard Rocket — pick CVA6 (RV64GC+S-mode Sv39 in-tree)
- 6-stage in-order, single-issue
- Optional 2-way superscalar variant
- 32 / 32 / shared cluster L2 (256 KB)
- 1.8-2.2 GHz
- IPC ~1.6
- Area ~0.25 mm² each

### Cluster topology (matches D9500 / Apple 2+4)

- 1× e1-ultra + 3× e1-premium + 4× e1-pro
- DSU-110-equivalent "e1-coherent-bus" with 16 MB SLC, MESI-class snoop filter, CHI-like protocol
- Per-core power gating, per-cluster DVFS, retention voltage for L1
- Management hart: separate small Ibex (lowRISC Apache-2.0) for boot/security/PMU
- Total CPU area budget (3 nm class): ~7 mm² (1×2.0 + 3×0.9 + 4×0.25 + DSU+SLC overhead)

### Open-source path recommendation (ranked)

1. **Fork XiangShan Kunminghu V3, scaled to 8-wide** — Mulan PSL v2 (Apache-compatible-ish), 6-wide native scaling toward 8-wide / ROB 512, "8% behind Neoverse N2", scalable 7/12/28 nm. Best fully-open with no vendor license. **Primary big-core path and mid core.**
2. **SonicBOOM (BOOMv3)** — UCB BSD, 2-4-wide configurable, 6.2 CoreMarks/MHz. Academic exploration / mid-core fallback.
3. ~~Tenstorrent Ascalon-D8~~ — 8-wide OoO RVA23 + 256-bit RVV, LLVM upstream. Surveyed as the leading commercial flagship-class core but **rejected**: mobile-volume IP license terms are not published and the closed RTL channel conflicts with the open-chip charter.
4. SiFive P870 — commercial license; macro-op fusion; not open RTL. Rejected.
5. Veyron V2 — datacenter-focused; not licensable for mobile. Rejected.

## D. Benchmarks / Eval / Testing

Required plan extending `cpu-npu-2028-readiness-scorecard.yaml` line 115-125:

| Benchmark | Metric | 2028 target (big core) | 2026 reference |
|---|---|---|---|
| SPEC CPU2017 int rate | per-core | ≥9 | X925 ~11.8, A19 ~12 |
| SPEC CPU2017 int speed | speed | ≥7 | X925 ~8, Zen 5 ~9 |
| SPEC CPU2017 fp rate | rate | ≥7 | X925 ~10, Zen 5 ~14 |
| Geekbench 6 ST | score | ≥2800 | A19 3895, Oryon Gen 3 3649, C1-Ultra 3502 |
| Geekbench 6 MT | score | ≥8500 (8-core) | A19 9988, S8EG5 11068, D9500 10417 |
| CoreMark/MHz | rate | ≥10 | BOOM 6.2, X925 ~13, Zen 5 ~12.5 |
| CoreMark-Pro | composite | ≥25k | enterprise/mobile parity gate |
| Embench-IoT | composite | full pass | small-program code-density gate |
| JetStream 2 (V8) | composite | ≥250 | Android/Chrome reality check |
| Octane 2.0 | score | ≥70k | legacy JS reality check |
| SPECjbb 2015 max-jOPS | jOPS | ≥40k | server-class java; CHI/coherency stress |
| STREAM Triad | GB/s | ≥150 | per `mobile-sota-2026.yaml` LPDDR5X |
| lmbench `lat_mem_rd` | ns at 1 GB stride | ≤120 ns | TLB+DRAM latency floor |
| lmbench `bw_mem` | GB/s | ≥120 | sustained memcpy |
| fio randread 4k QD32 | IOPS | ≥800k | UFS 4.1 path |
| systrace / perfetto cold-start | ms | ≤900 ms Chrome cold | D9500-class flagship |
| MLPerf Mobile (CPU fallback) | mobilenet-v3 / bert-mobile | within 2× NPU latency | "NPU real, CPU fallback acceptable" |

Required infrastructure:
- Cycle-accurate Verilator with FST waves, hooked to gem5 (XS-GEM5 fork claims >95% SPECCPU 2006 correlation, [openxiangshan/GEM5](https://github.com/OpenXiangShan/GEM5)).
- FireSim FPGA-accelerated full-system on AWS F1 / F2: boot Linux + SPEC at 100+ MHz.
- DiplomatTracer or equivalent for AMBA CHI traces.
- LLVM compiler perf regression with `llvm-test-suite`.
- Android RVA23 Cuttlefish boot (gated as `aosp_simulator_evidence_blocked`).
- Power: `powertop --html`, `iio:device*` rails on board.
- Thermal: ARM perfetto thermal_zone trace correlated with `cpu-npu-2028-burst-thermal-transient.json`.

## E. Optimizations: has / should / needs

### Has
- AXI-Lite contract scaffold + CVA6 wrapper boundary.
- Modeled CPU+NPU operating point (IPC 1.8 base / 2.42 SOTA, 3.2-3.8 GHz, 1.4 W).
- Process-14a derate model.
- Fail-closed evidence gates.
- Modeled benchmark harness passing `npu_arch_sim_open_2028` / `cpu_arch_sim_sota_2028`.

### Should (medium-term, Linux smoke)
- Real Chipyard Rocket integration.
- Full RV64GC + S-mode + Sv39 + CLINT + PLIC + UART boot.
- TileLink-AXI bridge with 64-bit data, atomics, MOESI snoop.
- OpenSBI + U-Boot + Linux 6.x + minimal Android container.

### Definitely needs (2028 flagship)
1. TAGE-SC-L with 16K L1 BTB and 64K L2 BTB; ITTAGE for indirect; RAS for calls.
2. PRF-based register renaming (energy < ROB-based at 400+ regs).
3. Distributed schedulers, capture-rename — X925 4×28 beats unified.
4. Store-set predictor for memory disambiguation.
5. RVWMO with optional Ztso PTE-bit — enables Box64-like x86 emulation without 4-12% fence-tax.
6. Macro-op fusion: `lui+addi`, `lui+ld`, `slli+add`, `auipc+jalr`, `addi+bne`. RISC-V fusion ~5.4% effective inst reduction.
7. L0 µop cache (3-4 K, 12-wide read).
8. Decoupled fetch — branch-predict-ahead queue feeds 4-deep fetch to L1I.
9. 2-cycle conditional branch predictor + 1-cycle BTB hot path — Oryon Gen 3 specifically improved.
10. Aggressive clock gating on FP/V; SVE2/SME-equivalent shutdown for INT-only.
11. Per-core power gating <50 µs wake; retention voltage on L1.
12. Spectre/Meltdown mitigations: invisible speculation (InvisiSpec / DAWG-like cache partitioning); 3-7% IPC if architected from day 1, 10-20% if bolted on.
13. Hardware page-table walker with 4-port concurrent walks.
14. Coherent IOMMU/SMMU for NPU and GPU sharing CPU virtual address.
15. CHI-like coherent bus with snoop filter (MOESI or MESIF).
16. Cluster shared L3 + SoC SLC two-level (matches D9500 16 + 10).
17. Hardware prefetchers: stream + stride + region + entanglement at L2; matches A18+.
18. DVFS with workload-aware governors, EAS-style with Android scheduler — Tensor G5 underperforms partly due to weak DVFS, not weak silicon.

## F. Risks and open questions

### Licensing
- **Ascalon-D8 (rejected)**: Tenstorrent IP licensing for mobile SKUs is not published. LLVM merges upstream, but the RTL is commercial IP. The unpublished mobile-volume terms and closed RTL channel are why Ascalon was surveyed but rejected; the selected big core is the open Kunminghu V3 scale-up.
- **Kunminghu V3**: Mulan PSL v2 GPL-3-like with copyleft. Combining with proprietary Android BSP at link time murky. Cooley LLP / RISC-V International legal review required.
- **CVA6**: Solderpad / Apache-2.0; integration risk low, but in-order so 2028 flagship impossible from CVA6 alone.
- **BOOM**: BSD; cleanest legally, but research-grade RTL.

### RTL maturity
- Tenstorrent Ascalon silicon-proven (surveyed, not selected — RTL not licensable for our open mobile SKU).
- XiangShan Kunminghu V3 (selected, big + mid) taped out at academic node (28 nm), not flagship 3 nm. Verification gap to 3 nm large; the 8-wide big-core scale-up is additionally unmeasured.
- BOOM has FPGA evidence (Zynq, AWS F1) but no commercial ASIC tapeout.
- All open OoO RISC-V cores lack validated PPA on N3P/N3B.

### Verification debt
- Flagship-class OoO needs: 10⁹+ random instruction tests (RISCV-DV, Imperas riscv-tests), formal proof of memory ordering, Spectre/MDS gadget audits, 4-week+ AVP nightly regressions, deadlock liveness for coherent fabric, ECC injection.
- Open RISC-V has nothing comparable to Arm AVS. Commission RISC-V Compliance Test Suite extensions for V/Ztso/SME.
- Formal-vs-Linux-boot gap: core can pass formal RVA23 conformance and hang Linux at userspace TLB shootdown (real bug in early Cortex-A57). Need targeted Linux kernel race-condition stress (LKDTM, LTP, stress-ng) on FPGA before tapeout.

### Software ecosystem
- RVV 1.0 compiler: GCC 14+/LLVM 19+ usable but auto-vectorizer ~30-50% behind ARM NEON. Hand-written intrinsics for hotspots (memcpy, libc, ffmpeg, OpenSSL) need explicit funding.
- Android RISC-V: Google paused 2024, restarted limited support contingent on RVA23. Mainline AOSP RVA23 expected late 2026/2027. Binary-app ecosystem (Snapchat, TikTok, banking) lags 2-3 years.
- Matrix extension (Zama, RVM): not ratified mid-2026. Lock-in risk to path that doesn't ratify.
- JIT performance: V8/Hermes/ART JIT on RISC-V ~70% of NEON-on-ARM per JetStream2. Significant work for Android usability.

### Hardware design open questions
- PTE-bit-driven Ztso: only Veyron has implemented per-page TSO toggles. Need ISA WG buy-in.
- Cluster heterogeneity: with 1+3+4, does cluster shared L3 hang off DSU-like uncore or split? D9500 splits SLC. Apple unifies.
- NPU coherency: `docs/spec-db/npu-2028-target.yaml` requires `cache_coherent_cpu_submission`. CHI-coherent NPUs rare; Tensor G5 TPU non-coherent.
- Vector vs Matrix: 2×256-bit RVV vs 1×512-bit + matrix tile is same arithmetic, vastly different software cost. Matrix wins for transformer prefill; RVV wins for image/audio/general.

### Schedule risk
- 2028 tapeout from 2026-05 requires: pick core decision by Q4 2026, RTL freeze Q4 2027, tapeout 2028H1, sample silicon 2028H2.
- Open RISC-V has slipped 2-3× on similar schedules (BOOM, XiangShan).
- Conservative: **target 2029 phone product with 2028 dev-board silicon**, 12 months for Android compatibility and CTS/VTS.

## Summary recommendation

1. **Big core**: 8-wide decode, ~512 ROB, ~256+256 PRF, distributed schedulers, RV64GCB+V+H+Sv48, ~3.4 GHz, ~2 mm² 3 nm. Selected path: **scale up the open XiangShan Kunminghu V3 to 8-wide** (Mulan PSL v2, no vendor license). Tenstorrent Ascalon-D8 was surveyed but rejected (unpublished mobile IP license).
2. **Mid core**: XiangShan Kunminghu V3 6-wide, ~256 ROB, 3.2 GHz, ~0.85 mm². 3 instances.
3. **Little core**: CVA6 6-stage in-order, 2.0 GHz, ~0.25 mm². 4 instances.
4. **Topology**: 1+3+4 matching D9500 / Apple; CHI-coherent DSU with 8 MB L3 + 16 MB SLC; Ibex mgmt hart.
5. **Memory ordering**: RVWMO native + Ztso (per-page PTE bit) for x86/ARM binary translation.
6. **Benchmark gates**: GB6 ST ≥2800, MT ≥8500, SPEC2017 int rate/core ≥9, JetStream2 ≥250.
7. **Honest 2028 stretch**: parity with C1-Ultra GB6 3502 / Oryon Gen 3 3649; A19 Pro 3895 is aspirational.
8. **Schedule**: realistic phone-silicon target slips to 2029 product (2028 dev-board).

## Sources

- [Chips and Cheese — Arm Cortex X925](https://chipsandcheese.com/p/arms-cortex-x925-reaching-desktop)
- [Chips and Cheese — Hot Chips 2024 Oryon](https://chipsandcheese.com/p/hot-chips-2024-qualcomms-oryon-core)
- [Chips and Cheese — Lion Cove](https://chipsandcheese.com/p/lion-cove-intels-p-core-roars)
- [Chips and Cheese — SiFive P870 Hot Chips 2023](https://chipsandcheese.com/p/hot-chips-2023-sifives-p870-takes-risc-v)
- [AMD Hot Chips 2024 Zen 5 slides](https://hc2024.hotchips.org/assets/program/conference/day2/24_HC2024.AMD.Cohen.Subramony.final.pdf)
- [AnandTech Lunar Lake Lion Cove deep-dive](https://www.anandtech.com/show/21425/intel-lunar-lake-architecture-deep-dive-lion-cove-xe2-and-npu4/3)
- [Arm Newsroom: C1-Ultra cluster](https://newsroom.arm.com/blog/arm-c1-cpu-cluster-on-device-ai-performance)
- [WikiChip Fuse: Cortex-X925 launch](https://fuse.wikichip.org/news/7761/arm-launches-next-gen-flagship-cortex-x925/)
- [Tenstorrent Ascalon IP](https://tenstorrent.com/en/ip/risc-v-cpu)
- [xpu.pub Ascalon analysis](https://xpu.pub/2025/10/09/tenstorrent-ascalon/)
- [Phoronix: LLVM Tenstorrent Ascalon-D8](https://www.phoronix.com/news/LLVM-20-Tenstorrent-Ascalon)
- [github.com/OpenXiangShan/XiangShan](https://github.com/OpenXiangShan/XiangShan)
- [XiangShan RVSE25 tutorial](https://tutorial.xiangshan.cc/rvse25/slides/20250512-RVSE25-XiangShan-Tutorial.pdf)
- [SonicBOOM CARRV 2020 paper](https://carrv.github.io/2020/papers/CARRV2020_paper_15_Zhao.pdf)
- [Ventana Veyron V2 (The Next Platform)](https://www.nextplatform.com/2023/11/07/ventana-launches-veyron-v2-risc-v-into-the-datacenter/)
- [Tom's Hardware: A19 Pro vs 9950X benchmarks](https://www.tomshardware.com/pc-components/cpus/apples-a19-pro-beats-ryzen-9-9950x-in-single-thread-geekbench-tests-iphone-17-pro-chip-packs-11-12-percent-cpu-performance-bump-gpu-performance-up-37-percent-over-predecessor)
- [Notebookcheck: A19 Pro specs](https://www.notebookcheck.net/Apple-A19-Pro-Processor-Benchmarks-and-Specs.1126974.0.html)
- [RISC-V RVA23 profile ratification](https://riscv.org/blog/risc-v-announces-ratification-of-the-rva23-profile-standard/)
- [RISC-V Ztso spec](https://docs.riscv.org/reference/isa/unpriv/ztso-st-ext.html)
- [Celio et al. macro-op fusion for RISC-V](https://arxiv.org/pdf/1607.02318)
