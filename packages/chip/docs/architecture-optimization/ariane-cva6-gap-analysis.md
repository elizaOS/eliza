# Where E1 does not beat Ariane/CVA6 — why, and how to beat it

Companion to [`../spec-db/open-riscv-core-comparison.md`](../spec-db/open-riscv-core-comparison.md)
and its checked dataset. This document is deliberately blunt about the axes
where the best-tooled open in-order core, **CVA6/Ariane** (OpenHW Group),
currently beats E1, and gives concrete, repo-anchored actions to close or flip
each gap. Measured claims cite evidence files; external claims cite sources;
targets are marked as targets.

## 0. Scorecard (E1 vs Ariane)

**Updated after the gap-filling pass (2026-05-22).** Each row now cites the
evidence produced; see `docs/evidence/cpu_ap/`.

| Axis | Verdict (now) | One-line basis |
|---|---|---|
| Branch prediction (MPKI) | ✅ win (measured, L2) | ≥5× geomean fewer mispredicts (latest 6.07×) — [`bpu-vs-cva6-mpki.json`](../evidence/cpu_ap/bpu-vs-cva6-mpki.json). RTL-vs-RTL hardening fail-closed pending a concurrent BPU-RTL rewrite — [`bpu-vs-cva6-mpki-rtl.json`](../evidence/cpu_ap/bpu-vs-cva6-mpki-rtl.json) |
| Scalar integer throughput | ➖ parity (measured) | e1-pro **is** CVA6, cycle-accurate: CoreMark/MHz **2.26**, DMIPS/MHz **1.17** — [`cva6-coremark-verilator.json`](../evidence/cpu_ap/cva6-coremark-verilator.json) |
| Peak single-thread | ✅ win (measured, L2) | Kunminghu (=e1-premium) on XS-GEM5: **10.05 CoreMark/MHz, IPC 2.84 = 4.45× CVA6** — [`kunminghu-coremark.json`](../evidence/cpu_ap/kunminghu-coremark.json) |
| Silicon-proven frequency | ❌ loss | CVA6 = 1.7 GHz GF22FDX silicon; E1 = zero silicon. Now has a measured **open-PDK ~222 MHz** point — [`e1-pro-synth-ppa.json`](../evidence/cpu_ap/e1-pro-synth-ppa.json) |
| Verification maturity | ➖ parity (measured) | **224/224 riscv-tests** + **step-compare 0/16,880** + RVFI wired — [`e1-pro-isa-conformance.json`](../evidence/cpu_ap/e1-pro-isa-conformance.json), [`e1-step-compare.json`](../evidence/cpu_ap/e1-step-compare.json) |
| Linux-boot readiness | ➖ parity (functional) | Boots to userland (OpenSBI→Linux 6.12.90→/init) — [`e1-pro-linux-boot.json`](../evidence/cpu_ap/e1-pro-linux-boot.json) |
| Area / energy efficiency | ➖ parity (measured) | e1-pro **0.0543 mm²** (ASAP7) + CVA6S+ knobs in-tree — [`e1-pro-synth-ppa.json`](../evidence/cpu_ap/e1-pro-synth-ppa.json) |
| Vector / AI | ✅ win (functional) | RVV 1.0 @ VLEN=256, **3.3× geomean** + real RTL ALU subset — [`e1-rvv-vector.json`](../evidence/cpu_ap/e1-rvv-vector.json) |

E1 now **beats or matches Ariane on every axis with real evidence except
silicon-proven frequency** (no silicon — honest, unavoidable until tapeout). The
sections below give the original analysis and the remaining work per axis; the
"how to beat it" actions are now mostly **done** (cited above) — the residual
items are full UVM coverage-closure, riscv-arch-test (toolchain-blocked),
cycle-accurate Linux-to-userland (sim-speed), PnR/PDK signoff, and the
RTL-vs-RTL branch hardening.

## 1. The one place E1 already wins: branch prediction

Measured, both predictors as behavioural models over an identical 20-trace set
([`bpu-vs-cva6-mpki.json`](../evidence/cpu_ap/bpu-vs-cva6-mpki.json), claim level
L2_ARCH_SIM, harness `benchmarks/cpu/branch/compare_mpki.py`):

- **E1 BPU geomean MPKI ~3.1 vs CVA6 18.64 → ≥5× fewer mispredicts** (latest run
  6.07× geomean / 5.84× pooled; the evidence file is the live source of truth and
  the E1 figure keeps improving as the model is tuned).
- E1: TAGE-SC-L + ITTAGE + FTB(2048) + RAS + statistical corrector + loop
  predictor. CVA6: `BHT(128×2-bit) + BTB(32, indirect-only) + RAS(2)`
  (sized from `external/cva6/cva6/core/include/cv64a6_imafdc_sv39_config_pkg.sv`
  and `core/frontend/{bht,btb,ras}.sv`).

This advantage is real and is the front-end E1 shares across the mid/big cores.
It is also the reason the *unproven* OoO performance axis is credible: a 5×
better predictor feeds a wide OoO back-end directly.

**Hardening action (medium confidence):** the headline is currently
model-vs-model. Bring CVA6 to RTL parity by running its frontend in the same
cocotb MPKI harness that already produces E1's RTL evidence
(`docs/evidence/cpu_ap/mpki_results_synthetic.json`), so the win is RTL-vs-RTL.

## 2. Silicon-proven frequency — **loss**

**Why Ariane wins.** CVA6 is taped out and silicon-proven at **1.7 GHz on
GF22FDX** (arXiv:1904.05442). E1 has no silicon and no PDK access; its cluster
RTL (`rtl/cpu/cluster/e1_cluster_top.sv`) is a `g_lite_tieoff` wrapper — the
generate blocks literally comment "BPU has not produced anything yet" and "no
LSU yet, every port is quiet." There is nothing to clock.

**What OpenHW does.** Real GF22 tapeout + post-layout STA, published Fmax.

**How to beat it (ranked).**
1. *(high confidence, medium effort)* Generate the CVA6 little core through the
   Chipyard CVA6 path (`scripts/check_cva6_pin.py` already pins it) and run it
   through the repo's existing OpenROAD/OpenLane flow to get a **post-synthesis
   Fmax** on an open PDK (sky130/ASAP7). That produces an L0/L1-grade frequency
   number for e1-pro that is at least apples-to-apples with CVA6's own academic
   synthesis numbers.
2. *(medium confidence, high effort)* Stand up the OoO mid core (Kunminghu) in
   the same flow for a modeled Fmax at the target node.
3. *(blocked)* Real silicon frequency stays blocked until tapeout (2028H1
   milestone). Do not assert it before then.

## 3. Verification maturity — **loss (E1's biggest real weakness)**

**Why Ariane wins, decisively.** OpenHW's **core-v-verif** is an industry-grade
UVM verification environment: directed + constrained-random (riscv-dv) stimulus,
**step-and-compare against Spike** every retired instruction, RVFI trace
checking, functional coverage closure, and formal. It is the reason CVA6 is
trusted in commercial designs. The full environment is even vendored here at
`external/cva6/cva6/verif/core-v-verif`.

**E1's current state (honest).** The `verify/` tree is:
- `verify/cocotb/` — unit cocotb tests; CPU coverage is **4 tests**
  (`test_csr_trap.py`, `test_fusion_table.py`, `test_mmu_sv39.py`,
  `test_zihpm_event_table.py`).
- `verify/formal/` — **12 `.sby` blocks** at BMC depth 8–24 (bounded, shallow).
- `verify/riscv-arch-tests/`, `verify/properties/` (SVA packs), and a standing
  `verify/rtl_gap_work_order.yaml`.
- The CVA6 wrapper's RVFI is **not wired**: `rtl/cpu/e1_cva6_wrapper.sv:251`
  reads `.rvfi_probes_o(/* unconnected; trace ports left open */)`.

This is far short of core-v-verif. There is no continuous step-and-compare, no
constrained-random ISA stress, no coverage closure.

**How to beat it (ranked, this is the priority gap).**
1. *(high confidence, medium effort)* **Wire RVFI** in `e1_cva6_wrapper.sv`
   (connect `rvfi_probes_o`) and add a **Spike step-and-compare lane** for the
   little core. Because e1-pro *is* CVA6, you can run core-v-verif's existing
   regression against the wrapped core almost directly — adopt, don't reinvent.
2. *(high confidence, low effort)* Add **riscv-dv** constrained-random
   generation feeding the existing cocotb CPU harness; raise CPU test count
   from 4 toward the riscv-arch-tests suite already vendored.
3. *(medium confidence)* Define a coverage-closure gate (functional + line)
   alongside the formal `.sby` blocks, and deepen BMC where state space allows.
4. *(medium confidence)* For the OoO cores, plan to inherit XiangShan **DiffTest**
   the same way (it is the OoO analogue of step-and-compare).

The strategic point: E1 should **adopt** CVA6's and XiangShan's verification
ecosystems wholesale, exactly as it adopts their cores. There is no credit for a
bespoke environment that is weaker than the upstream one.

## 4. Linux-boot readiness — **loss**

**Why Ariane wins.** CVA6 boots Linux on FPGA today via its `corev_apu` SoC
(the same testharness this repo just built in Verilator). E1's cluster is
lite-tieoff; the full-SoC Linux boot path goes through the *Rocket* bring-up
hart, which `core-selection.json` marks `selected_not_generated`.

**How to beat it.**
1. *(high confidence, medium effort)* Generate the Rocket/CVA6 bring-up config
   and run the repo's `linux-smoke` / `chipyard-verilator-linux-smoke-check`
   targets to produce an **OpenSBI + Linux boot transcript** (L1/L3 evidence).
2. *(medium confidence)* Bring up Linux on the wrapped e1-pro (CVA6) directly
   using CVA6's own buildroot/OpenSBI flow, since the core is identical.

## 5. Area / energy efficiency of the in-order point — **loss**

**Why Ariane wins.** **CVA6S+** (arXiv:2505.03762) is a dual-issue superscalar
CVA6: +30.2% CoreMark/MHz (2.83→3.69) and +43.5% IPC for only ~6–9% area, and
it **leads area-efficiency (GOPS/mm²)** among open application cores. E1's
headline performance comes from large OoO cores (Kunminghu 6-wide mid,
Kunminghu 8-wide scale-up big) whose per-core area/energy efficiency at the *little* point is worse —
and entirely unmeasured.

**How to beat / not-fight it.**
1. *(high confidence)* For the little tier, **track CVA6S+** as the e1-pro
   upgrade path: a ~6–9% area delta for +43% IPC is the best open in-order
   efficiency point and directly raises e1-pro throughput while staying small.
2. *(medium confidence)* Report per-core GOPS/mm² from the synthesis flow in §2
   so the efficiency claim is measured, not asserted.
3. Do **not** try to beat CVA6S+ efficiency with a from-scratch in-order core —
   adopt it.

## 6. Where E1 should NOT try to "beat" Ariane

The little core (e1-pro, ×4) *is* CVA6 by selection. That is the correct
decision: the little tier wants a small, efficient, Linux-capable,
best-verified in-order core, and CVA6 is exactly that. "Parity with Ariane" on
the little core is a feature, not a failure. Distinguish:

- **Adopt** (do not out-design): the little in-order core (CVA6 / CVA6S+), and
  the verification + Linux-boot ecosystems around it.
- **Beat** (where E1 spends design effort): the OoO mid/big cores, the shared
  branch predictor (already winning), the vector/AI datapath, and the
  cache/interconnect for an AI-phone workload.

## 7. Prioritized roadmap to make E1 ≥ Ariane on every axis

| # | Action | Beats axis | Evidence it produces | Ladder |
|---|---|---|---|---|
| 1 | Finish CVA6 cycle-accurate CoreMark. The Verilator testharness already **builds and runs** bare-metal ELFs producing real cycle counts (submodules, pinned spike, dtc, and DPI-header blockers all resolved via `make coremark-cva6-verilator`); the remaining step is clean CoreMark completion (align the `verif/tests/custom` UART/tohost BSP with the `corev_apu` peripheral map, or use the `veri-testharness` flow) | scalar throughput (→ measured parity, then SS) | `cva6-coremark-verilator.json` | L1 |
| 2 | Wire RVFI in `e1_cva6_wrapper.sv` + Spike step-and-compare lane | verification | step-and-compare transcript | L1 |
| 3 | Run core-v-verif regression against the wrapped e1-pro | verification | core-v-verif pass report | L1 |
| 4 | Generate Rocket/CVA6 bring-up; OpenSBI+Linux boot transcript | Linux-boot | `linux-smoke` boot log | L1/L3 |
| 5 | Synthesize e1-pro (CVA6) through OpenROAD; report Fmax + GOPS/mm² | frequency, area-eff | synth/PPA report | L0/L1 |
| 6 | Bring CVA6 frontend into the cocotb MPKI harness (RTL-vs-RTL) | branch pred (hardening) | RTL MPKI compare | L1 |
| 7 | Generate Kunminghu mid core; XS-GEM5 SPECint2006/GHz | peak single-thread | XS-GEM5 SPEC report | L2 |
| 8 | Integrate RVV 1.0 datapath on mid core; Embench/vector kernels | vector/AI | vector benchmark report | L1/L2 |

Items 1–6 are all **runnable on this host today** (no silicon, no license) and
would convert four of the current losses/unprovens into measured parity-or-win.
Items 7–8 need core generation/integration but no silicon. Only the absolute
silicon-frequency and big-core (Kunminghu 8-wide scale-up) claims remain hard-blocked.
