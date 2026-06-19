# 05 — CPU & Memory Performance, Co-Designed With the TEE

This document is the **performance experiment plan** for the Eliza E1 CPU and
memory subsystem, written so that the security architecture of the whole-OS TEE
(siblings `01-tee-core-architecture.md`, `03-secure-io-iommu-npu.md`,
`04-side-channel-physical-hardening.md`, `06-os-on-tee-software.md`) does not
silently destroy the product's other headline requirement: the E1 must be
**fast** — premium-Android-adjacent, on-device-LLM-class — as well as
ultra-private.

It is an experiment plan, not a results report. Every quantitative target here
is a **hypothesis to be measured** through the existing fail-closed gates. No
phone-class IPC, latency, or bandwidth claim in this file is evidence; each
remains `BLOCKED` until a named gate records a signed transcript from a
full-system simulator or silicon. That discipline is inherited from
`docs/arch/ooo-cluster.md`, `docs/arch/cache-hierarchy.md`, and
`docs/arch/memory-subsystem.md`, and it is non-negotiable.

The security taxes this plan must fight are enumerated in
`docs/security/confidential-domain.md` §"Side-Channel Requirements":

- no SMT for confidential domains (or provable partitioning),
- cache / TLB / BPU / prefetcher **flush or partition** on domain switch,
- PMU and high-resolution counter disablement or virtualization,
- constant-time boot and key code,
- memory confidentiality + integrity (MEE) for whole-OS TEE,
- IOPMP/IOMMU translation on every DMA master including the NPU.

Section 6 is the highest-value section: for each tax it proposes a mitigation
that recovers performance **without weakening the security claim**.

---

## 1. Baseline + methodology

### 1.1 What actually exists today (audited)

| Block | File(s) | Maturity | Verdict |
| --- | --- | --- | --- |
| Little-core integration | `rtl/cpu/e1_cva6_wrapper.sv` | Real OpenHW CVA6 v5.3.0 (`cv64a6_imafdc_sv39`) behind `+define+E1_HAVE_CVA6`; flat-AXI4 adapter `rtl/top/adapters/e1_cva6_to_e1axi4.sv`; safe-idle when undefined. | **Real RTL boundary.** In-order, single-issue, RV64GC+S/Sv39. SPECint IPC ~1.5–1.8 (per `sota-2028/ooo-execution.md` §B). |
| Smoke core | `rtl/cpu/e1_cpu_subsystem_stub.sv` | 8-state FSM, ~12 opcodes, no CSR/MMU/traps. | **Smoke only.** Not a performance vehicle; do not grow it. |
| Cluster top | `rtl/cpu/cluster/e1_cluster_top.sv` | Parameterized 1+3+4 tie-off skeleton, `E1_HAVE_*` gated. | **Contract skeleton.** Big/mid cores `BLOCKED` on the open Kunminghu external checkout / scale-up fork. |
| Branch prediction | `rtl/cpu/bpu/` (TAGE×5, SC×6, H2P neural sidecar, learned local-dir meta, optional bias/IMLI correctors default-off, 2-way ITTAGE×5, loop, RAS, FTB 2048×4, uFTB 512, FTQ 64) | Substantial synthesizable BPU; target-module cocotb aggregate is 103/103 across 10 counted modules, excluding auxiliary debug/MPKI runs, with L1I frontend integration and MPKI harness evidence on CBP-5. | **Substantial RTL, pre-silicon evidence.** Scaled XiangShan-Kunminghu derivative; the most mature OoO-relevant block in-tree. |
| Macro-op fusion | `rtl/cpu/fusion/fusion_pkg.sv` (19 pairs) | Contract package only; `fusion_detect.sv` not yet written. | **Contract, no datapath.** Detection lands with rename/dispatch. |
| RVV | `rtl/cpu/rvv/rvv_csr.sv` (7 CSRs real), `rvv_unit_stub.sv` | CSR/`vsetvl` real; arithmetic is a **behavioral pass-through stub**. | **CSR real, datapath BLOCKED.** No vector ALU. |
| Cache hierarchy | `rtl/cache/{l1i,l1d,l2,l3,slc}` + 7 prefetchers + DRRIP/Hawkeye/Mockingjay + BDI | Four-level + SLC, all synthesizable/Verilator-runnable. SLC has way-partition + way-shutoff + per-client QoS. | **Real RTL, sim-only evidence.** ChampSim DPC-3 traces only; phone-class `BLOCKED`. |
| DRAM | `rtl/memory/dram_ctrl/e1_dram_ctrl.sv`, `e1_axi4_dram_model.sv`, root `dramsim3.json/.txt`, `compiler/runtime/dramsim_wrap/` | DRAM controller RTL + DRAMsim3 LPDDR model + Python wrap/sweep. Boot path still SRAM-backed AXI-Lite. | **Model real, capacity/timing BLOCKED.** No LPDDR PHY/training. |
| IOMMU | `rtl/iommu/e1_riscv_iommu.sv` | RISC-V IOMMU v1.0.1 register/fault surface, allowlist/PASID behavior, IOFENCE.C fetch/decode/completion, and a local DDT + Sv39 first-stage KAT under identity G-stage. Non-identity G-stage/PDT/full Linux evidence, ATS/PRI/MSI behavior, invalidation side effects, and protected-domain policy remain blocked. | **Partial RTL evidence.** Useful scaffold, not complete TEE isolation evidence. |
| NPU | `rtl/npu/e1_npu.sv` (1083 lines) + planned Gemmini wrapper | MMIO descriptor-ring datapath real; Gemmini 16×16 INT8 is the v0 selection; CPU fallback contract. | **Real MMIO NPU.** Systolic array is a generator pin, `BLOCKED`. |

**Bottom line:** the front-end (BPU) and the cache/SLC hierarchy are the most
mature OoO-relevant RTL in the package. The OoO **back-end** (rename, ROB,
schedulers, LSU, vector ALU) does not exist as datapath — it is contract +
skeleton, deliberately deferred to the open Kunminghu V3 scale-up fork.
This shapes the whole plan: **do not grow the stub into an OoO core.** Lean on
an upstream OoO generator and spend E1-specific effort on the front-end,
cache/SLC, vector/NPU datapath, the compiler, and the TEE co-design seams.

### 1.2 Measurement loop

```
RTL  --(Verilator lint/sim)-->  cocotb functional + HPM counters
 |                                   |
 |                                   v
 |                            MPKI / hit-rate / latency micro-evidence
 v
ChampSim DPC-3 traces (cache + prefetch + replacement sweeps)
 |
 v
DRAMsim3 LPDDR model  <--  compiler/runtime/dramsim_wrap/runner.py
 |
 v
[BLOCKED] full-system: XS-GEM5 (XiangShan, >95% SPEC2006 correl.) + FireSim FPGA
 |
 v
[BLOCKED] silicon: dev-board 2028H2, phone 2029
```

The loop is real up to and including DRAMsim3 and ChampSim DPC-3. Everything
that needs cycle-accurate full-system numbers (SPEC, GB6, JetStream, AOSP
cold-launch) is `BLOCKED` per `sota-2028/ooo-execution.md` §D and the gates in
`docs/evidence/cpu_ap/` and `docs/evidence/cache/`.

### 1.3 What is BLOCKED, and on what

| Capability | Gate that fails closed | Unblocked by |
| --- | --- | --- |
| Flagship IPC / GB6 / SPEC | `make cpu-ap-completion-gate`, `docs/evidence/cpu_ap/geekbench6-equivalent.yaml` | Big-core fork + XS-GEM5/FireSim |
| Real branch MPKI on real workloads | `docs/arch/branch-prediction.md` Accuracy table | SPEC license + gem5-XiangShan, AOSP/simpleperf trace |
| Vector arithmetic | `docs/evidence/cpu_ap/rvv-1-0-execution.yaml` | Vector backend (Ara/Spatz/Kunminghu-V) |
| Phone-class cache latency/hit-rate | `docs/evidence/cache/cache-evidence-gate.yaml` | Silicon or full-system sim |
| DRAM bandwidth/latency | `docs/evidence/memory/uma-dram-evidence-gate.yaml` | LPDDR5X PHY + board |
| NPU systolic throughput | `make npu-scale-sim-check`, `scale-feasibility-gate` | Gemmini generator pin + SCALE-Sim/silicon |

---

## 2. CPU core experiments

### 2.0 Core-sourcing decision (the highest-leverage CPU choice)

The single biggest performance lever is **not** an RTL tweak — it is the
back-end source. `sota-2028/ooo-execution.md` §C already ranks the options;
this plan commits to the experiment sequence:

- **E2.0a — Mid core first on Kunminghu V3.** Stand up XiangShan Kunminghu V3
  (Mulan PSL v2) as the `e1-premium` slot under `E1_HAVE_MID` in the cluster
  top, and bring it up in XS-GEM5 (the XiangShan fork claims >95% SPEC2006
  correlation). This is the fastest route to a *real* OoO baseline we can
  instrument, because the BPU already in-tree is a Kunminghu derivative — the
  front-end contract (`bpu_pkg.sv`, FTQ→L1I) was built to attach to it.
  **Gate:** `make xiangshan-generator-check`, then a new
  `docs/evidence/cpu_ap/kunminghu-gem5-baseline.yaml` (`BLOCKED` until the
  generator pin + sim transcript exist).
- **E2.0b — Big core: open Kunminghu V3 8-wide scale-up.** Tracked behind the
  existing `core-selection-gate.yaml`. Do not write a bespoke 8-wide core. The
  selected path is the open Kunminghu scale-up (no vendor license; Ascalon-D8
  surveyed but rejected for lack of published mobile license); the gate is the
  external checkout + scale-up microbench, not licensing.
- **E2.0c — Reject growing the stub or CVA6 into OoO.** CVA6 stays the
  `e1-pro` little core (in-order, ~1.6 IPC); the FSM stub stays a smoke target.

Everything below assumes the OoO datapath arrives via E2.0; the experiments
target the **E1-specific blocks bolted onto it**.

### 2.1 Front-end (highest in-tree leverage)

The BPU is real and the FTQ decouples it from fetch (FDIP-style). Front-end
experiments are measurable **now** via the MPKI harness without the OoO
back-end.

- **E2.1a — TAGE-SC-L geometry sweep.** Sweep `TAGE_HIST_LEN`,
  `TAGE_ENTRIES_TABLE`, SC table count against CBP-5 and (when unblocked)
  AOSP/simpleperf traces. Hypothesis: reach ≥120 history closes most of the
  MPKI gap to X925-class. **Gate:** `make mpki-eval-rtl`,
  `docs/evidence/cpu_ap/mpki_results_synthetic.json`.
- **E2.1b — Two-taken-per-cycle.** Lift `MAX_BR_PER_BLOCK` 1→2 with a
  dual-port FTB read and non-contiguous fetch (BPU blocker #2). Hypothesis:
  +5–10% front-end bandwidth on branchy Android UI / JIT code. **Gate:**
  `make cocotb-bpu` + a new dual-fetch cocotb case.
- **E2.1c — Macro-op fusion datapath.** Implement `fusion_detect.sv` against
  the 19-pair `fusion_pkg.sv` contract; prioritize `lui+addi`, `auipc+jalr`,
  `lui+ld`, `slli+add`, `addi+bne`. Hypothesis: ~5–6% effective inst-count
  reduction (Celio et al.); recovers RISC-V code-density loss vs ARM. **Gate:**
  `verify/cocotb/cpu/test_fusion_table.py`.
- **E2.1d — L0 µop cache (3–4K, 12-wide).** Bypasses decode for hot loops
  (Apple / Lion Cove). Hypothesis: front-end energy/cycle win on tight loops;
  also a TEE win (see §6, fewer decode-side replays after a flush). Effort
  high; sequence after E2.0.

### 2.2 Back-end (OoO width / ROB / scheduler)

These experiments live in the chosen OoO generator's config space, evaluated in
XS-GEM5 before any RTL freeze.

- **E2.2a — ROB / PRF / scheduler width sweep.** Sweep ROB 256→512, PRF
  192→400, unified vs distributed schedulers. Hypothesis: distributed (X925
  4×INT-cluster style) beats unified at ≥8-wide on energy at equal IPC.
- **E2.2b — Store-set memory disambiguation + 4-way store-to-load forward.**
  Hypothesis: removes false load-stalls that dominate JS/JIT workloads.
- **E2.2c — Ztso per-page mode.** The control surface exists
  (`rtl/cpu/csr/ztso_ctrl.sv`, CSR `0x7C0`, Sv39 RSW bit 8). Wire the LSU
  consumer (`lsu_op_is_tso_o`) when the back-end lands. Hypothesis: removes
  4–15% fence-spam for Box64/FEX/QEMU-translated x86/ARM apps. **Gate:**
  `docs/evidence/cpu_ap/csr-trap-evidence.yaml` (currently `BLOCKED` on LSU).

### 2.3 Path recommendation

**Mid-core-first on Kunminghu V3 in XS-GEM5**, with the in-tree front-end (BPU,
fusion) and cache/SLC as the E1 differentiators, and the big core selected as
the open Kunminghu V3 8-wide scale-up. Do not build a bespoke OoO back-end.

---

## 3. Cache + memory hierarchy

The four-level hierarchy + SLC is real RTL with a focused pre-silicon evidence harness
(`make champsim-prefetch-sweep`, `make mockingjay-vs-lru-sweep`,
`make dramsim-sweep`, targeted cocotb cache tests). `make lmbench-cache-curve`
and phone-class memory evidence remain blocked until the RV64 lmbench source,
toolchain, and target metadata land. Leverage here is **high and measurable
today** in ChampSim/DRAMsim3/cocotb, even before the OoO back-end.

- **E3.1 — Prefetcher bake-off → ship-list.** Sweep the seven in-tree
  prefetchers (Berti, BOP, SPP, IPCP, stride, FDIP-L1I, Pythia-stub) on DPC-3.
  Hypothesis: Berti/IPCP at L2 + FDIP at L1I is the Pareto front for the
  Android-ish memory mix. Promote winners per level; demote the rest behind a
  config. **Gate:** `make champsim-prefetch-sweep`,
  `docs/evidence/cache/champsim_prefetch_sweep_report.json`. Pythia is a
  `BLOCKED` stub (`e1_pythia_stub.sv`) — keep it fail-closed.
- **E3.2 — Replacement policy.** DRRIP default; Mockingjay-prod now passes the
  synthetic cocotb +10% relative threshold per
  `mockingjay_cocotb_synthetic_report.json`. DPC-3, full-system, and
  phone-class evidence remain blocked. Hypothesis: Mockingjay closes most of
  the LRU→Belady gap at L3/SLC. **Gate:**
  `make cocotb-cache-mockingjay-accuracy`, `make mockingjay-vs-lru-sweep`.
- **E3.3 — SLC as LPDDR-traffic filter.** The 16 MB SLC with BDI compression
  is the primary lever for cutting external-memory energy/traffic — the
  dominant cost in mobile AI (Eyeriss: data movement dominates). Sweep SLC
  size (8/16/32 MB), BDI on/off, and way-alloc per QoS class against DRAMsim3.
  Hypothesis: SLC + BDI cuts LPDDR bytes/inference by a large margin on
  weight-streaming NPU traffic. **Gate:** `make dramsim-sweep` +
  `make lmbench-cache-curve`; `docs/evidence/cache/cache-evidence-gate.yaml`.
- **E3.4 — MLP / MSHR depth.** Sweep L2/L3 MSHR counts and L1D 2R/2W bank
  count. Hypothesis: deeper MSHRs are the cheapest way to raise memory-level
  parallelism for pointer-chasing (lmbench `lat_mem_rd`). **Gate:**
  `make lmbench-cache-curve` + cocotb MSHR-pressure case.
- **E3.5 — DRAM scheduling / QoS.** Use DRAMsim3 to compare FR-FCFS variants
  and the SLC's eight QoS classes (`qos_class_e`) under a display+NPU+CPU
  contention mix. Hypothesis: a display-RT reservation window + NPU-bulk
  demotion holds display underflow at zero while keeping NPU bandwidth high.
  **Gate:** `make memory-iommu-qos-sim-check`, `make dramsim-sweep`.

Expected leverage ranking: **SLC/BDI (E3.3) > prefetch ship-list (E3.1) >
DRAM-QoS (E3.5) > MLP (E3.4) > replacement (E3.2)** for the AI-heavy mobile
profile, because external-memory traffic is the energy-dominant term.

---

## 4. Vector + NPU datapath (the headline AI workload)

On-device AI is the product headline, so the vector and NPU datapaths plus
their compiler/runtime co-design carry the most product-visible leverage — and
today the vector ALU is a stub and the systolic array is a generator pin.

- **E4.1 — RVV vector backend.** Replace `rvv_unit_stub.sv` with a real vector
  unit. Evaluate **Ara** (lane-based, CVA6-attached — natural fit for the
  little/mid path) and **Spatz** (compact, SSR-style streaming) as the
  datapath donors. Target the per-role contract in `docs/arch/rvv-1-0.md`
  (ultra 2×256b, premium 1×128b). Hypothesis: a real RVV unit lifts INT8/FP16
  GEMM and audio/vision kernels well above scalar CVA6. **Gate:**
  `docs/evidence/cpu_ap/rvv-1-0-execution.yaml` (currently `BLOCKED`).
- **E4.2 — NPU dataflow + on-chip SRAM tiling.** The v0 NPU is a Gemmini 16×16
  INT8 systolic array (`docs/arch/npu-microarch.md`) with a software-managed
  scratchpad (TPU lesson: big array + SW-managed SRAM). Experiment with tile
  sizes, double-buffered weight staging in `rtl/memory/e1_weight_buffer_sram.sv`,
  and **DMA/compute overlap** so weight fetch hides behind MAC time
  (Eyeriss/row-stationary dataflow lesson). Hypothesis: tiling + double-buffer
  keeps the array >80% utilized on transformer prefill. **Gate:**
  `make npu-scale-sim-check`, `make npu-context-queue-sim-check`,
  `scale-feasibility-gate`.
- **E4.3 — Quantization (FP8 / INT).** Drive the existing
  `compiler/quantization/` path toward INT8 (present) and FP8 (E5) weight
  formats; co-tune per-tensor scale (hard-wired 1.0 in NPU v0). Hypothesis:
  FP8 weights halve SLC/LPDDR weight traffic vs INT16-equivalent staging at
  acceptable accuracy. **Gate:** `compiler/quantization/tests` +
  `make npu-runtime-contract-check`.
- **E4.4 — IREE/TVM autotuning co-design.** `compiler/iree-eliza-npu/` already
  has descriptor-parity and MMIO-parity tests. Experiment with IREE
  tile/fuse/schedule autotuning targeting the NPU descriptor ABI and the SLC
  QoS class `QOS_NPU`. Hypothesis: autotuned tiling beats hand-fixed tiling on
  end-to-end model latency. **Gate:** `make npu-runtime-contract-check`,
  `compiler/iree-eliza-npu/tests`.

Co-design note: E4.2–E4.4 must respect §6's NPU isolation — the NPU is **secure
I/O**, not a normal peripheral (`confidential-domain.md` I/O rule). Tiling that
assumes shared SLC ways with the CPU must be re-validated under way-partitioned
SLC.

---

## 5. Compiler-side performance

Stacked PGO is a documented 12–18% system-image win
(`sota-2028/compiler-tuning.md` §A) and is **mostly orthogonal to silicon** — a
high return on near-term effort. Harnesses already exist:
`compiler/autofdo-harness/`, `compiler/propeller-harness/`,
`compiler/bolt-harness/`, `compiler/baseline-profiles/`.

- **E5.1 — AutoFDO + Propeller stack.** Capture profiles via
  `autofdo-harness/capture.sh`, relink via `propeller-harness/relink.sh`.
  Hypothesis: ~10% throughput on the system image; 32% iTLB-miss reduction from
  Machine Function Splitter (directly compounds with E2.1d µop-cache and §6
  TLB pressure). **Gate:** `compiler/autofdo-harness/coremark_roundtrip.sh`,
  `make coremark`.
- **E5.2 — BOLT on hot binaries.** `bolt-harness/optimize.sh` on libc, ART/JIT,
  ffmpeg, OpenSSL. Hypothesis: +2–6% atop FDO+LTO.
- **E5.3 — RVV autovectorization + hand-tuned kernels.** Autovec everywhere
  (LLVM is the canonical RVV target), then hand-write intrinsics for the top-N
  kernels (memcpy, libc, ffmpeg, OpenSSL, NPU pre/post-proc) where autovec
  trails 1.5–3× on stride/predicated loops. Tune LMUL per kernel. **Gate:**
  `benchmarks/compiler/autovec/`, `make embench`.
- **E5.4 — Security-on net.** Spectre mitigations cost 5–10% in tight loops;
  PGO recovers most of it. Track the *net* number once §6 mitigations are
  pinned, so the security build's real cost is measured, not assumed.

---

## 6. TEE-aware co-design (highest value)

For each TEE tax from `confidential-domain.md`, the goal is a mitigation that
**recovers performance without weakening the security claim**. Sibling
`04-side-channel-physical-hardening.md` is the authority on *where* hardening
costs performance and which mitigations are sound; this section proposes the
*performance-recovery* counterpart and must stay consistent with it. Where a
mitigation could weaken isolation, it is marked **must-prove** and fails closed
until `04` signs off.

### 6.1 Domain-switch flush of cache / TLB / BPU / prefetcher

- **Tax.** `confidential-domain.md` requires flush *or partition* on domain
  switch. Full flush of L1/L2/TLB/BPU on every world switch is a cold-start
  cliff (hundreds of cycles refill, MPKI spike).
- **Mitigation — partition, don't flush.**
  - **SLC/L3 way-partition (ready in RTL).** `rtl/cache/slc/e1_slc.sv` already
    has `way_alloc_mask[8]` per QoS class and `way_enable_mask`. Assign
    confidential-domain SLC ways disjoint from host ways so domains *coexist*
    in cache with no flush, DAWG/InvisiSpec-style. **must-prove:** way
    isolation is a real non-interference boundary (no shared replacement
    state) — `04` owns the proof.
  - **ASID/domain-tagged TLB & BPU.** Tag TLB entries and BPU history/FTB with
    a domain ID so a switch *gates visibility* instead of *invalidating
    state*. The BPU already carries history-folding and ASID-shaped indexing;
    extend the FTB/TAGE tag with a domain field. **must-prove:** tagged
    structures must not allow cross-domain training leakage; if unprovable,
    fall back to flush. Where flush is mandatory, hide it behind a small
    domain-private warm BTB/uFTB snapshot restored on re-entry.
- **Experiment.** Measure MPKI and L2/SLC miss-rate under a synthetic
  world-switch storm with (a) full flush, (b) way-partition, (c) domain-tagged.
  **Gate:** `make mpki-eval-rtl`, `make lmbench-cache-curve`, new cocotb
  domain-switch case; cross-checked against `04`.

### 6.2 No-SMT for confidential domains

- **Tax.** SMT is disabled (or must be provably partitioned) for confidential
  domains, losing the throughput SMT would give.
- **Mitigation.** The E1 big core is **single-thread per core by design**
  (`ooo-cluster.md` has no SMT), so there is *no SMT to lose* — turn the
  constraint into a non-cost. Recover throughput via the heterogeneous 1+3+4
  topology + EAS-style DVFS governor: schedule confidential work on a dedicated
  core and let the scheduler fill the rest. **Experiment:** governor-trace
  sweep. **Gate:** `make cpu-npu-aosp-governor-trace`.

### 6.3 Memory encryption + integrity (MEE) latency

- **Tax.** Whole-OS TEE needs external-memory confidentiality + integrity; an
  integrity tree (Merkle) adds DRAM round-trips on the miss path.
- **Mitigation — integrity-tree caching + SLC as the encryption filter.**
  Cache the upper integrity-tree nodes on-chip (a small dedicated SRAM or a
  pinned SLC way) so most checks hit on-die, hiding MEE latency behind the
  cache that already exists. Place the MEE at the **SLC↔DRAM boundary**
  (`tl_c_to_chi_bridge.sv`) so on-die SLC hits pay zero MEE cost — only true
  LPDDR traffic is encrypted/verified. This makes E3.3 (SLC hit-rate) do
  double duty: every SLC hit is also an MEE saving. **must-prove:** counter +
  tree freshness vs replay — owned by `01`/`04`. **Experiment:** DRAMsim3
  sweep of integrity-node cache size vs effective miss latency. **Gate:**
  `make dramsim-sweep`, `docs/evidence/memory/uma-dram-evidence-gate.yaml`.

### 6.4 IOMMU translation on every DMA master (incl. NPU)

- **Tax.** Per-master IOMMU translation (`confidential-domain.md` I/O rule;
  `03-secure-io-iommu-npu.md`) adds a page-walk to the NPU/display/DMA path.
- **Mitigation target — ATS/PRI + per-PASID IOTLB + walk caching.** The current
  RISC-V IOMMU RTL has local evidence for the register/fault surface, BARE
  behavior, IOFENCE.C fetch/decode, a minimal DDT + Sv39 first-stage read walk
  under identity G-stage, and allowlist isolation. ATS/PRI transaction behavior,
  full PDT/PASID handling, and non-identity G-stage translation remain blocked
  by `docs/evidence/memory/iommu-evidence-gate.yaml`. Give the NPU command queue
  its own PASID and let ATS pre-translate descriptor addresses only after those
  blocked items have evidence. Size the IOTLB and page-walk-cache for the NPU's
  large contiguous tensor strides (the access pattern is highly regular — easy
  to cover). **Experiment:**
  IOMMU+QoS sim sweep of IOTLB size and ATS-on/off under NPU+display traffic.
  **Gate:** `make memory-iommu-qos-sim-check`, `make cocotb-iommu`. **must-prove:**
  ATS translations are revoked on teardown/reset and cannot outlive a domain
  (`03` owns the revocation contract).

### 6.5 Prefetch disabled in some secure modes

- **Tax.** Cross-domain prefetch is a side channel; disabling prefetch in
  confidential mode reintroduces miss latency that §3 spent effort removing.
- **Mitigation — domain-confined prefetch, not disabled prefetch.** Keep
  prefetchers **on but confined**: a prefetcher trained inside a domain may
  only issue requests whose targets stay within that domain's partitioned ways
  (§6.1), and prefetch state is tagged + gated like the BPU (§6.1). This keeps
  intra-domain MLP (E3.1/E3.4) while denying the cross-domain training channel.
  Where confinement is unprovable for a given prefetcher, fail closed to
  disabled in confidential mode. **must-prove:** owned by `04`. **Experiment:**
  DPC-3 sweep with prefetch (a) off, (b) domain-confined, (c) unrestricted —
  measure the recovered hit-rate of (b) vs (a). **Gate:**
  `make champsim-prefetch-sweep`.

### 6.6 PMU / high-resolution counter virtualization

- **Tax.** PMU disablement/virtualization for confidential domains
  (`confidential-domain.md`) removes the counters perf/AutoFDO/Propeller (§5)
  rely on — risking a profiling blind spot exactly on the secure build.
- **Mitigation — per-domain virtualized Zihpm.** The Zihpm aggregator
  (`rtl/cpu/csr/zihpm.sv`) and the BPU PMU remap already exist. Virtualize the
  counters per domain so a confidential domain can profile *itself* (enabling
  AutoFDO/Propeller inside the TEE) while never reading host or cross-domain
  events. **Experiment:** confirm AutoFDO capture works against virtualized
  counters. **Gate:** `make pmu-event-alignment-check`,
  `compiler/autofdo-harness/capture.sh`. **must-prove:** no cross-domain event
  leakage — `04` owns the channel analysis.

### 6.7 Net-cost accounting

The security build's *real* performance is the sum of §6.1–§6.6 residual costs
**minus** §5 PGO recovery. The plan's success criterion is: **measured net
overhead of the confidential domain stays in single digits**, not zero. That
net number is itself a `BLOCKED` claim until XS-GEM5/FireSim transcripts exist;
the gates above produce the component evidence that will let it be computed.

---

## 7. Prioritized experiment table

Priority = leverage / effort, biased toward what is measurable in-tree today.
Risk: **L** low, **M** medium, **H** high. PPA impact is a hypothesis to be
proven by the named gate, never an as-built claim.

| # | Experiment | Hypothesis (PPA) | Effort | Risk | Measuring gate |
| --- | --- | --- | --- | --- | --- |
| P0 | E3.1 Prefetcher ship-list (Berti/IPCP@L2 + FDIP@L1I) | +hit-rate, −LPDDR traffic on Android mix | M | L | `make champsim-prefetch-sweep` |
| P0 | E3.3 SLC+BDI as LPDDR filter (size/BDI/way sweep) | Large −LPDDR bytes/inference | M | L | `make dramsim-sweep`, `make lmbench-cache-curve` |
| P0 | E2.1c Macro-op fusion datapath (`fusion_detect.sv`) | ~5–6% effective inst-count ↓ | M | M | `verify/cocotb/cpu/test_fusion_table.py` |
| P0 | E6.1 SLC/TLB/BPU way-partition + domain-tag (vs flush) | Removes world-switch cold-start cliff | M | H (must-prove vs `04`) | `make mpki-eval-rtl`, `make lmbench-cache-curve` |
| P0 | E5.1 AutoFDO+Propeller on system image | ~10% throughput, −iTLB miss | M | L | `compiler/autofdo-harness/coremark_roundtrip.sh`, `make coremark` |
| P1 | E2.1a TAGE-SC-L geometry sweep | −MPKI toward X925-class | M | L | `make mpki-eval-rtl` |
| P1 | E6.3 MEE integrity-tree cache at SLC↔DRAM | Hides MEE latency behind SLC hits | M | H (must-prove vs `01`/`04`) | `make dramsim-sweep` |
| P1 | E6.4 NPU PASID + ATS pre-translation | ~0 steady-state IOMMU walk on NPU DMA | M | M (revocation vs `03`) | `make memory-iommu-qos-sim-check`, `make cocotb-iommu` |
| P1 | E6.5 Domain-confined prefetch (vs disabled) | Recovers intra-domain MLP in secure mode | M | H (must-prove vs `04`) | `make champsim-prefetch-sweep` |
| P1 | E4.2 NPU tiling + DMA/compute overlap | Array util >80% on prefill | M | M | `make npu-scale-sim-check`, `scale-feasibility-gate` |
| P1 | E3.5 DRAM-QoS contention (display+NPU+CPU) | 0 display underflow at high NPU BW | M | M | `make memory-iommu-qos-sim-check` |
| P2 | E2.0a Kunminghu V3 mid core in XS-GEM5 | First real OoO baseline to instrument | H | M (license) | `make xiangshan-generator-check` (+ new gem5 evidence) |
| P2 | E4.1 RVV vector backend (Ara/Spatz) | Vector kernels ≫ scalar CVA6 | H | M | `docs/evidence/cpu_ap/rvv-1-0-execution.yaml` |
| P2 | E5.3 RVV autovec + top-N hand kernels | Close 1.5–3× autovec gap on hot loops | M | M | `benchmarks/compiler/autovec/`, `make embench` |
| P2 | E2.1b Two-taken-per-cycle FTB | +5–10% front-end BW on branchy code | M | M | `make cocotb-bpu` (new dual-fetch case) |
| P2 | E6.6 Per-domain virtualized Zihpm | AutoFDO works inside TEE, no leak | M | M (must-prove vs `04`) | `make pmu-event-alignment-check` |
| P3 | E3.2 Mockingjay-prod finish | LRU→Belady gap closed at L3/SLC | M | M | `make cocotb-cache-mockingjay-accuracy` |
| P3 | E3.4 MSHR / MLP depth sweep | −pointer-chase latency | L | L | `make lmbench-cache-curve` |
| P3 | E4.3 FP8 quantization | −SLC/LPDDR weight traffic | M | M | `compiler/quantization/tests`, `make npu-runtime-contract-check` |
| P3 | E4.4 IREE/TVM NPU autotuning | −end-to-end model latency | M | M | `make npu-runtime-contract-check` |
| P3 | E2.2 ROB/PRF/scheduler width sweep | IPC/energy Pareto at ≥8-wide | H | M | XS-GEM5 (new evidence, `BLOCKED`) |
| P3 | E2.2c Ztso per-page LSU consumer | −4–15% fence-spam on translated apps | H | M | `docs/evidence/cpu_ap/csr-trap-evidence.yaml` |
| P3 | E2.1d L0 µop cache | front-end energy ↓ on hot loops | H | M | XS-GEM5 / new cocotb (`BLOCKED`) |

**Sequencing.** Do the P0 in-tree-measurable wins first (prefetch ship-list,
SLC/BDI, fusion, PGO) plus the one P0 security-recovery experiment whose RTL is
already present (way-partition). They need no big-core fork and produce signed
evidence through gates that exist today. P1 deepens the front-end and the
TEE-recovery seams (MEE cache, NPU ATS, confined prefetch). P2/P3 depend on the
OoO fork (E2.0) and the vector/NPU datapaths landing, and stay `BLOCKED` behind
their named gates until XS-GEM5/FireSim/silicon evidence exists.

---

## 8. Cross-references

- `01-tee-core-architecture.md` — domain model, MEE freshness/replay contract
  (owns the §6.3 must-prove).
- `03-secure-io-iommu-npu.md` — IOMMU source-ID policy, NPU-as-secure-I/O,
  ATS revocation contract (owns the §6.4 must-prove).
- `04-side-channel-physical-hardening.md` — authority on where hardening costs
  performance; owns the non-interference proofs for §6.1, §6.5, §6.6.
- `06-os-on-tee-software.md` — scheduler/governor and PGO build integration
  for §5 and §6.2.
- `docs/arch/ooo-cluster.md`, `branch-prediction.md`, `cache-hierarchy.md`,
  `memory-subsystem.md`, `rvv-1-0.md`, `npu-microarch.md` — the RTL contracts
  these experiments target.
- `docs/architecture-optimization/sota-2028/` — the SOTA reasoning these
  hypotheses are grounded in (`ooo-execution.md`, `cache-hierarchies.md`,
  `memory-subsystem.md`, `compiler-tuning.md`, `branch-predictors.md`).

No claim in this document is silicon evidence. Each experiment is bound to a
fail-closed gate; phone-class numbers stay `BLOCKED` until those gates record
signed full-system-simulator or silicon transcripts.
