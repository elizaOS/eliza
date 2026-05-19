# Branch Predictor SOTA — 2028 RISC-V Phone-Class AP

Sub-report of [2028-sota-integrated-report.md](../2028-sota-integrated-report.md).

## A. SOTA snapshot (2026 → 2028)

### A.1 Conditional branch predictors — the TAGE family is universal

Every credible high-IPC core in 2025-2026 — Apple, Qualcomm, ARM, Intel, AMD, BOOM, XiangShan — uses a TAGE-derived multi-component conditional predictor. Differences are in storage budget, history lengths, statistical-corrector add-ons, and how the front-end is decoupled from fetch.

- **Apple Firestorm** (A14/M1): six tagged PHTs, ~44K total entries, 4/6-way, history geometric to 100-bit PHRT + 28-bit PHRB. MPKI on SPECint 2017 narrowly beats Oryon (~1%); both beat Intel Skylake by >20%. ([Garza et al., arXiv 2411.13900](https://arxiv.org/html/2411.13900v1))
- **Qualcomm Oryon** (Snapdragon X Elite, Oryon Gen 3 family): six PHTs with ~40K entries / ~80 KB inc. tags, history lengths 100/52/27/14/7/4 (PHRT). RAS 48 entries. Indirect predictor 2,048 entries. Misprediction penalty 13 cycles. 8-wide decode, 192 KB L1I. ([Chips and Cheese: Oryon](https://chipsandcheese.com/p/qualcomms-oryon-core-a-long-time-in-the-making))
- **AMD Zen 5**: L1 BTB 16K entries, L2 BTB 8K, two-block-ahead predictor, 2 taken branches/cycle across non-contiguous blocks, dual 32 B/cycle fetch into two 4-wide decode clusters. ([Chips and Cheese: Zen 5 2-Ahead BPU](https://chipsandcheese.com/p/zen-5s-2-ahead-branch-predictor-unit-how-30-year-old-idea-allows-for-new-tricks))
- **Intel Lion Cove**: L0 BTB 256 entries / ~2 KB reach, zero-bubble; L2 BTB 6K / 2 cycles; L3 BTB 12K / 3-4 cycles. RAS 24 entries two-level. µop cache 5,250 µops, 12 µops/cycle. 8-wide decode, 2 taken branches/cycle. ([Chips and Cheese: Lion Cove](https://chipsandcheese.com/p/lion-cove-intels-p-core-roars))
- **ARM Cortex-X925**: L1 BTB ~2,048 entries / 2 taken branches/cycle; large slow BTB ~16,384 / 2-3 cycle latency; RAS 29; 10-wide fetch. ([Chips and Cheese: X925](https://chipsandcheese.com/p/arms-cortex-x925-reaching-desktop))
- **Apple A18/A19 Pro**: Apple-disclosed "improved front-end bandwidth and branch prediction" on A19. Firestorm-class storage (~44K entries) is the credible lower bound.

### A.2 Open RISC-V references

- **CVA6 (Ariane) default `cv64a6_imafdc_sv39_hpdcache`** — `BTBEntries=32`, `BHTEntries=128`, `RASDepth=2`. Single-issue in-order, 6-stage. Categorically inadequate for a 2028 flagship-mobile AP.
- **BOOM** uses TAGE-L (TAGE + loop) behind a small NLP (micro-BTB + BIM + RAS). MegaBoom budgets TAGE around 4-8 KB with ~6 tagged tables.
- **XiangShan Kunminghu v2** — current SOTA open-source high-performance RISC-V BPU:

  | Component | Configuration |
  | --- | --- |
  | uFTB (micro-FTB, 1-cycle) | 256 entries, 4-bit GHR |
  | FTB (Fetch Target Buffer, replaces BTB) | 2,048 entries, 4-way, 20-bit tag |
  | TAGE conditional | 4 tables × 4,096 × 8-bit tags; histories {8, 13, 32, 119} — 16K total |
  | ITTAGE indirect | 5 tables × {256,256,512,512,512} × 9-bit tags; histories {4,8,13,16,32} — ~2K |
  | RAS | 16 architectural / 32 speculative, 3-bit counter |
  | SC | 4 tables × 512 rows × 6-bit, histories {0,4,10,16} |
  | FTQ | 64 entries |
  | IBuffer | 48 entries |
  | Decode width | 6 |

  XiangShan reports SPECCPU2006 above 15 points/GHz on Kunminghu, with v3 targeting 20/GHz.

### A.3 Championship Branch Prediction (CBP-5 / CBP2025)

192 KB total storage budget, with 64 KB TAGE-SC-L baseline:

- **TAGE-SC-L** (Seznec, SiFive): 64 KB → 3.986 MPKI on CBP-5 train traces.
- **Bullseye** (Behrendt et al.): 159 KB TAGE-SC-L + 28 KB H2P perceptron → 3.4045 MPKI.
- **BATAGE** (Michaud): TAGE-SC-L accuracy at 8 KB with no SC/local/loop.
- **ITTAGE** (indirect SOTA): 64 KB → 0.193 misp/Ki on SPEC + mobile.

### A.4 Decoupled front-end and FDIP

Every flagship core uses a decoupled BPU running ahead of fetch via an FTQ. Modern revisits show FDIP recovers most front-end stall when BPU accuracy holds, but degrades badly on mobile/server workloads with large I-footprints — exactly the Android case. ([UDP](https://hlitz.github.io/papers/UDP.pdf); [PDIP, ASPLOS '24](https://dl.acm.org/doi/abs/10.1145/3620665.3640394); [DEER, arXiv 2504.20387](https://arxiv.org/html/2504.20387))

### A.5 Power/area

A dynamic predictor reduces cycles ~10%, adds ~7% core power on average. For a 1-2 W mobile big-core: BPU power 3-6%, BPU+L1I area 5-10%.

### A.6 Front-end MPKI on Android-class code

AsmDB (ISCA '19) shows datacenter and large mobile workloads spend a substantial fraction of cycles in front-end stalls dominated by I-cache and BTB misses, not data misses. The repo's SOTA-2-core model encodes per-workload MPKI of 1.116 (CoreMark-like), 3.472 (Linux kernel mix), 4.464 (Android UI), 1.922 (TFLite CPU fallback). These are reasonable planning numbers for a 2028 flagship.

## B. Current state in `packages/chip`

1. **Tiny CPU stub** at `rtl/cpu/e1_cpu_subsystem_stub.sv` — no branch predictor of any kind. Every branch resolved by sequential FSM.
2. **CVA6 integration wrapper** at `rtl/cpu/e1_cva6_wrapper.sv`, gated by `E1_HAVE_CVA6`. Brings the toy default predictor: 32-entry BTB, 128-entry 2-bit bimodal BHT, 2-entry RAS.
3. **Selected AP path**: Chipyard 1.13.0 `ElizaRocketConfig`. Rocket's BPU is similarly minimal.
4. **Architecture planning** does not enumerate branch prediction as a workstream.
5. **Modeled MPKI** in `benchmarks/results/simulator-arch-metrics-sota.json` is a static input to the perf/W model, not driven by any predictor structure.

Honest claim today: the project has zero branch prediction implementation, evidence, or planning artifact specific to that subsystem.

## C. Recommended target (2028)

### C.1 Predictor topology

Adopt **XiangShan Kunminghu BPU shape**, scaled to a 2028 flagship envelope. Kunminghu/KMH-v3 is the only open-source RISC-V design in 2025-2026 with a credible, taped-out, publicly-documented TAGE-SC + ITTAGE + uFTB/FTB + RAS + SC + loop stack. BOOM TAGE-L is a viable fallback; from-scratch BPU is multi-year risk.

Hard targets for the big P-core:

| Component | Target | Rationale |
|---|---|---|
| Family | TAGE-SC-L + ITTAGE + RAS, FTB-based, decoupled BPU with FTQ | Matches XiangShan KMH and Apple/Oryon storage class |
| uFTB | 512 entries, 4-way, ~16 KB reach for zero-bubble | Above KMH 256; below X925 2K |
| FTB | 8,192 entries, 8-way, 24-bit tag, 2 taken/cycle | Match X925 hierarchy |
| L2 BTB | 16,384, 2-3 cyc | Match X925/Zen 5 reach |
| TAGE-SC conditional | 5 tables × 4-8 K, ~64-96 KB, histories geometric to ~200 bits | KMH currently 16K/4 tables; CBP-5 floor 64 KB |
| Statistical corrector | 4-8 tables × 1K rows, signed counters | Standard tail |
| Loop predictor | 64 entries | Cheap, high payoff on SPEC libquantum/leela |
| ITTAGE | 5-6 tables × ~512 entries, history to 64 bits, ~2-3K total | Above KMH ~2K; below Oryon 2,048-indirect |
| RAS | 32 architectural / 64 speculative, with overflow handling | KMH 16/32; Oryon 48; X925 29; Lion Cove 24 |
| FTQ | 64-96 entries | KMH 64; needed for FDIP |
| Misprediction penalty | ≤ 12-14 cycles | Oryon 13, Zen 4/5 13 |

### C.2 Decoupled front-end and FDIP

Implement FDIP from day one. BPU must run ahead of fetch via FTQ and emit prefetch requests into L1I. Add a shadow structure (per-FTB next-line hint or AsmDB-style boot-up I-prefetch) to defend against Android cold-launch I-footprint blowups.

### C.3 Micro-op cache vs decoded instruction cache

For RISC-V mobile flagship: skip a full µop cache (Lion Cove 5,250 µop / 12-wide is x86-baroque; RISC-V's fixed encoding makes decode cheap). Use a small decoded-instruction buffer (KMH IBuffer = 48 entries). Apple-style move is larger L1I (64-128 KB) with FDIP, not a µop cache. Oryon's 192 KB L1I is the existence proof.

### C.4 Fetch width

- Prediction width = 32 B/cycle = 1 FTB entry/cycle = up to 16 RVC inst/prediction block.
- Decode width = 6-8.
- Up to 2 taken branches/cycle at BPU. Now table-stakes — Zen 5, X925, Lion Cove all do it.

### C.5 Accuracy targets

| Workload | MPKI target | Plausibility |
|---|---|---|
| SPECint 2017 average | ≤ 4.0 | TAGE-SC-L 64 KB CBP train 3.986; Bullseye 3.4 |
| 505.mcf | ≤ 11 | Branch-misp dominated; X925/Zen 5 zone |
| 541.leela | ≤ 5 | Loop+H2P heavy |
| Geekbench 6 Navigation | ≤ 6 | Skymont reported 4.33 |
| Android UI (ART/JIT) | ≤ 5 | Tracks repo planning 4.464 |
| Android cold-launch | ≤ 8 | Stall-dominated; FDIP + L1I more than predictor accuracy |
| Linux kernel mix | ≤ 4 | Repo planning 3.472 |

### C.6 Open core selection

Primary: track **XiangShan Kunminghu v2 → v3** upstream and patch into the e1 SoC. Add `eliza-kunminghu-manifest.json` discipline + `make xiangshan-generator-check`. Keep CVA6 wrapper for first Linux/Android bring-up smoke. Do not plan a from-scratch BPU.

## D. Benchmarks / eval / testing

### D.1 Branch tracing harness

Three layers under `packages/chip/benchmarks/`:

1. **Functional / golden traces.** ChampSim-style or CBP2025 trace format ([ramisheikh/cbp2025](https://github.com/ramisheikh/cbp2025)). QEMU `-d in_asm,nochain` or Spike branch-trace plugin to dump (PC, target, taken, kind).
2. **gem5-XiangShan** ([OpenXiangShan/GEM5](https://github.com/OpenXiangShan/GEM5)) for cycle-level. XiangShan ships a calibrated Kunminghu model.
3. **RTL co-sim** with branch counters in CSRs (RV PMU/HPM). Cocotb dumps per-workload MPKI vs gem5 with documented tolerance.

### D.2 Standard benchmarks

| Benchmark | Why |
|---|---|
| SPEC CPU2017 intrate (gcc, mcf, leela, omnetpp, xalancbmk, perlbench, deepsjeng, exchange2, x264, xz) | Industry standard; license-gated |
| Embench-IoT 1.0 | Permissive, RISC-V-native |
| CoreMark-Pro | Permissive successor; modest branch pressure |
| Geekbench 6 + open equivalents | Competitor comparison axis |
| AsmDB Android traces + AOSP simpleperf | Real Android front-end pressure |
| JetStream2 / Octane v2 in V8/Hermes | Indirect-branch heavy; stresses ITTAGE |
| App-startup traces (Chrome, YouTube cold) | Closest to real flagship benchmark axis |

### D.3 SimPoint / LoopPoint

Mandatory; compress traces to ~10-100M-instruction representative checkpoints. Full SPEC2017 on cycle-accurate XS-gem5 / verilator + BPU is infeasible at iteration speed.

### D.4 Comparison methodology vs Oryon / C1-Ultra / A19 Pro

Measurable on competitor silicon:
- Geekbench 6 subscore deltas.
- ARM PMU branch events (`BR_MIS_PRED_RETIRED`, `BR_RETIRED`, `BR_IND_MIS_PRED_RETIRED`) via `simpleperf`.
- Cold-start time, JetStream2, Speedometer, AOSP `frame_metrics`.

Not measurable (closed):
- Internal BTB sizes, TAGE geometry, RAS depth, SC config of Apple/Qualcomm. Use reverse-engineering numbers (Garza et al., MDPI M2 paper, Chips and Cheese).

Gauntlet (gate before any 2028 BPU claim):
1. Front-end MPKI ≤ 4.0 SPECint avg, ≤ 5 on 5-app Android cold-launch set.
2. IPC with predictor disabled vs enabled: drop > 1.5×.
3. Taken-branch throughput ≥ 1.5/cycle sustained on branchy kernel.
4. RAS under/overflow under deep-recursion ≤ 0.1% returns.
5. ITTAGE accuracy ≥ 95% on V8/ART dispatch microbenchmark.

## E. Optimizations: has / should / needs

### Has
- Tiny RV stub with no BPU.
- CVA6 wrapper → toy 32-BTB / 128-BHT / 2-RAS predictor.
- Roadmap pointing at Chipyard Rocket (similarly toy).
- Static MPKI model in `simulator-arch-metrics{,-sota}.json`.

### Should (2026-2027)
- `docs/arch/branch-prediction.md` contract mirroring `cpu-subsystem.md` style.
- `eliza-kunminghu-manifest.json` pinning open BPU IP commit hash.
- `make branch-prediction-check` gate emitting BTB/FTB/TAGE/ITTAGE/RAS sizes to `docs/evidence/cpu_ap/branch-prediction-params.json`.
- gem5-XiangShan integration under `benchmarks/cpu/branch/`.
- Branch event counters via RV PMU (`Zihpm`).
- BPU power model in `compute-silicon.md` for the operating-point optimizer.

### Needs (2028 gating)
- Real TAGE-SC-L + ITTAGE + FTB + RAS + SC + loop in synthesizable RTL (XiangShan- or BOOM-derived).
- Decoupled front-end with 64+ FTQ and FDIP-style L1I prefetch.
- Two-taken-branches-per-cycle by 2028.
- L1I ≥ 64 KB (preferably 128-192 KB to match Oryon cold-launch).
- Misprediction penalty ≤ 14 cycles.
- PMU events for branch_taken, branch_misp, indirect_misp, ras_misp, fetch_bubble, btb_miss, ftq_full in Zihpm.
- Dedicated benchmark workstream wired into the readiness scorecard fail-closed.
- Management hart can stay CVA6/Rocket-class with toy predictor. Only big core needs the SOTA stack.

## F. Risks and open questions

1. **XiangShan licensing** — Mulan PSL v2; resolve before publishable AP target.
2. **BPU power at 3-4 GHz on N3/14A** — XiangShan silicon-proven on TSMC N28/N14 at 1-2 GHz; flagship clocks need dedicated timing budget.
3. **Apple/Oryon true config is proprietary** — target credible open-source SOTA (KMH-v2/v3), not Apple's internal numbers.
4. **CBP traces vs Android reality** — hardest residual MPKI on Android is front-end-bubble-driven, not direction-misp. Investing 192 KB in Bullseye-class while shipping a 32 KB L1I is wrong shape.
5. **Two-taken-per-cycle implementation cost** — largest BPU complexity step in the past decade. BOOM/Rocket cannot; KMH-v2 cannot; KMH-v3 is first XiangShan generation publicly targeting it.
6. **Verification IP** — no vendor-agnostic BPU-stress suite analogous to riscv-arch-tests. Either commission one or commit to XiangShan regression as the baseline.
7. **Indirect-branch coverage on Android** — ART/Hermes/V8 traces dominated by dynamic dispatch through inline caches; ITTAGE accuracy on those is poorly published.
8. **Branch-resolution latency vs OoO depth** — pipeline depth and BPU choice are not independent.
9. **PD/area budget** — 96-160 KB SRAM + tag arrays + logic, comparable to 32 KB L1I. Price into `pd/openlane` floorplan from day one.
10. **Repo discipline** — no branch-prediction workstream, scorecard entry, evidence manifest, or claim gate today.

## Sources

- [Chips and Cheese — Zen 5 2-Ahead BPU](https://chipsandcheese.com/p/zen-5s-2-ahead-branch-predictor-unit-how-30-year-old-idea-allows-for-new-tricks)
- [Chips and Cheese — Lion Cove](https://chipsandcheese.com/p/lion-cove-intels-p-core-roars)
- [Chips and Cheese — Cortex X925](https://chipsandcheese.com/p/arms-cortex-x925-reaching-desktop)
- [Chips and Cheese — Oryon](https://chipsandcheese.com/p/qualcomms-oryon-core-a-long-time-in-the-making)
- [Garza et al. — Firestorm + Oryon predictors, arXiv 2411.13900](https://arxiv.org/html/2411.13900v1)
- [Bullseye Predictor, arXiv 2506.06773](https://arxiv.org/html/2506.06773v1)
- [Seznec — TAGE-SC-L for CBP2025](https://ericrotenberg.wordpress.ncsu.edu/files/2025/06/cbp2025-final37-Seznec.pdf)
- [XiangShan Parameters.scala (kunminghu-v2)](https://github.com/OpenXiangShan/XiangShan/blob/kunminghu-v2/src/main/scala/xiangshan/Parameters.scala)
- [XiangShan KMH RISC-V Europe 2025 slides](https://riscv-europe.org/summit/2025/media/proceedings/2025-05-14-RISC-V-Summit-Europe-09h30-BAO-slides.pdf)
- [BOOM backing predictor docs](https://docs.boom-core.org/en/latest/sections/branch-prediction/backing-predictor.html)
- [CVA6 cv64a6_imafdc_sv39_hpdcache_config_pkg.sv](https://github.com/openhwgroup/cva6/blob/master/core/include/cv64a6_imafdc_sv39_hpdcache_config_pkg.sv)
- [Michaud — BATAGE](https://dl.acm.org/doi/fullHtml/10.1145/3226098)
- [Garza et al. — Bit-level Perceptron Indirect](https://people.engr.tamu.edu/djimenez/pdfs/p27-garza.pdf)
- [Apple M2 BTB reverse-engineered, MDPI](https://www.mdpi.com/2079-9292/14/23/4686)
- [Reinman/Calder/Austin — FDIP MICRO-32 1999](https://dl.acm.org/doi/10.5555/320080.320085)
- [DEER, arXiv 2504.20387](https://arxiv.org/html/2504.20387)
- [AsmDB, ISCA '19](https://liberty.cs.princeton.edu/Publications/isca19_frontend.pdf)
- [Qualcomm Snapdragon 8 Elite Gen 5 product brief](https://www.qualcomm.com/content/dam/qcomm-martech/dm-assets/documents/Snapdragon-8-Elite-Gen-5-product-brief.pdf)
