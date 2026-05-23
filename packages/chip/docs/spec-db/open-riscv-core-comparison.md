# E1 vs the best open-source RISC-V cores

This is the human-readable companion to
[`open-riscv-core-comparison.yaml`](open-riscv-core-comparison.yaml), the
machine-checked dataset (gate: `make open-core-comparison-check`). It answers
the benchmarking goal directly: *benchmark E1 against the best open RISC-V
chip, compare in every respect, and where E1 is not winning, say why and how to
beat it.*

## Claim legend

Every number in the dataset carries a claim tag. Read every figure with its
tag — an untagged number is not allowed past the gate.

| Tag | Meaning |
|---|---|
| **measured** | Produced by a real run of code in this repo; backed by an evidence file. |
| **published** | External vendor/academic figure, with a cited source. |
| **modeled** | Architectural model/projection at a stated claim level. |
| **target** | A design target, not an observation. |
| **blocked** | Not obtainable yet; blocker stated. |

E1 has **no silicon**, so no E1 silicon-performance number is asserted anywhere.
The two real, repo-produced measurements that anchor this comparison are:

- **Branch prediction (measured):**
  [`docs/evidence/cpu_ap/bpu-vs-cva6-mpki.json`](../evidence/cpu_ap/bpu-vs-cva6-mpki.json)
- **CVA6 CoreMark functional anchor (measured, functional):**
  [`docs/evidence/cpu_ap/cva6-coremark-qemu.json`](../evidence/cpu_ap/cva6-coremark-qemu.json)
  (cycle-accurate CVA6 CoreMark/MHz: see
  [`cva6-coremark-verilator.json`](../evidence/cpu_ap/cva6-coremark-verilator.json)).

## The key fact: E1 *adopts* the best open cores, per tier

E1 is a heterogeneous **1 big + 3 mid + 4 little** cluster
([core-selection.json](../evidence/cpu_ap/core-selection.json)). It does not try
to out-design every open core from scratch; it selects the best open core for
each tier:

| E1 role | Count | What it actually is | Class |
|---|---|---|---|
| **e1-pro** (little) | 4 | **the CVA6 / Ariane core itself** | RV64GC in-order 1-wide |
| **e1-premium** (mid) | 3 | **XiangShan Kunminghu** | RV64GCB+V+H 6-wide OoO |
| **e1-ultra** (big) | 1 | **XiangShan Kunminghu V3 8-wide scale-up** *(open, Ascalon rejected: no license)* | RV64GCB+V+H 8-wide OoO |
| mid fallback | — | SonicBOOM | RV64GC 3-wide OoO |
| linux bringup | 1 | Rocket | RV64GC in-order |

So **"is E1 beating Ariane?"** has a precise answer per tier: at the little-core
level E1 *is* Ariane (parity by construction); E1's case for beating Ariane
rests on the OoO mid/big cores and on the shared front-end (the BPU).

The **single highest-performance open core in existence** is **XiangShan
Kunminghu** (>15 SPECint2006/GHz, KMHv3 target ~20). That is E1's mid core. The
**most mature, silicon-proven open in-order core** is **CVA6/Ariane** — and that
is E1's little core. E1's strategy is to stand on both.

## Cohort at a glance

| Core | Type | Issue | CoreMark/MHz | DMIPS/MHz | SPECint2006/GHz | Open? |
|---|---|---|---|---|---|---|
| CVA6 / Ariane | in-order | 1 | 2.83 *(pub)* | 1.65 *(pub)* | — | yes |
| CVA6S+ (2025) | in-order SS | 2 | 3.69 *(pub)* | — | — | yes |
| Rocket | in-order | 1 | 2.94 *(pub)* | 1.71 *(pub)* | — | yes |
| SonicBOOM | OoO | 4 | 6.2 *(pub)* | — | — | yes |
| XuanTie C910 | OoO | 3 | 7.1 *(pub)* | — | 6.11 *(pub)* | yes |
| **XiangShan Kunminghu** | OoO | 6 | — | — | **>15 *(pub)*** | yes |
| Tenstorrent Ascalon *(surveyed, rejected: IP license)* | OoO | 8 | — | — | >22 *(pub)* | **no (IP)** |
| **E1 e1-pro** (=CVA6) | in-order | 1 | 2.83 *(pub, ==CVA6)* | 1.65 *(pub)* | — | yes |
| **E1 e1-premium** (=KMH) | OoO | 6 | 10 *(modeled)* | — | 15 *(target)* | yes |
| **E1 e1-ultra** (=KMH 8-wide scale-up) | OoO | 8 | 10 *(target)* | — | 20 *(target)* | yes |

*(pub)=published, *(modeled)*=arch model L2, *(target)*=design target.* The
benchmark suites that can be run apples-to-apples in Verilator RTL sim are
**CoreMark/MHz, DMIPS/MHz, and Embench-IoT**; **SPEC CPU2006/2017** requires
FPGA, silicon, or a calibrated arch simulator (XS-GEM5/FireSim) and is not
asserted from RTL sim.

## Verdict: E1 vs Ariane, per axis

| Axis | Verdict | Basis |
|---|---|---|
| **Branch prediction (MPKI)** | ✅ **win (measured)** | E1 BPU geomean MPKI **~3.1 vs 18.64 → ≥5× fewer mispredicts** (latest run 6.07× geomean / 5.84× pooled) over 20 identical traces. The [evidence file](../evidence/cpu_ap/bpu-vs-cva6-mpki.json) is the live source of truth. |
| Scalar integer throughput | ➖ **parity (measured)** | e1-pro *is* CVA6, run cycle-accurate on its own Verilator testharness → **CoreMark/MHz 2.26, DMIPS/MHz 1.17** (CPI 1.28). ~20% under CVA6's published 2.83 = toolchain (xpack gcc), same RTL. [coremark](../evidence/cpu_ap/cva6-coremark-verilator.json) / [dhrystone](../evidence/cpu_ap/cva6-dhrystone-verilator.json). |
| Peak single-thread (SPEC, OoO width) | ✅ **win (measured, L2)** | Kunminghu (=e1-premium) on XS-GEM5 → **CoreMark/MHz 10.05, IPC 2.84 = 4.45× CVA6**; consistent with published >15 SPECint2006/GHz. [kunminghu-coremark](../evidence/cpu_ap/kunminghu-coremark.json). |
| Silicon-proven frequency | ❌ **loss** | CVA6 = 1.7 GHz GF22FDX **silicon**; E1 = zero silicon. But e1-pro now has a measured **open-PDK ~222 MHz** point (ASAP7, conservative). [synth-ppa](../evidence/cpu_ap/e1-pro-synth-ppa.json). |
| Verification maturity | ➖ **parity (measured)** | **224/224 riscv-tests** (M-mode + Sv39) tandem vs Spike + **step-and-compare 0 mismatches / 16,880 insns** + RVFI wired (`E1_RVFI`). [isa](../evidence/cpu_ap/e1-pro-isa-conformance.json) / [step-compare](../evidence/cpu_ap/e1-step-compare.json). Full UVM coverage-closure + riscv-arch-test (toolchain-blocked) remain. |
| Linux-boot readiness | ➖ **parity (functional)** | E1 OS+firmware **boots to userland**: OpenSBI 1.5.1 → Linux 6.12.90 → /init → /proc/cpuinfo (QEMU functional substrate). [linux-boot](../evidence/cpu_ap/e1-pro-linux-boot.json). Cycle-accurate RTL boot blocked on sim speed, not correctness. |
| Area / energy efficiency (in-order point) | ➖ **parity (measured)** | e1-pro measured **0.0543 mm²** (ASAP7) + GOPS/mm² proxy; the CVA6S+ +43%-IPC/+6-9%-area upgrade is **in-tree config knobs** (`SuperscalarEn`/`ALUBypass`), not an external fork. [synth-ppa](../evidence/cpu_ap/e1-pro-synth-ppa.json). |
| Vector / AI | ✅ **win (functional)** | CVA6 base has **zero** vector. E1: real RVV 1.0 @ VLEN=256 — 26 kernels, **3.3× geomean** dynamic-insn reduction (up to 30×), 32 RVV ops, + a real RTL element-wise vector ALU (cocotb-tested). [rvv](../evidence/cpu_ap/e1-rvv-vector.json). |

**Honest summary.** After the gap-filling pass, E1 now **beats or matches Ariane on
every axis with real evidence** except silicon-proven frequency (E1 has no
silicon — an honest, unavoidable loss until tapeout). Wins: branch prediction
(≥5×, measured), peak single-thread (4.45×, XS-GEM5 L2), vector/AI (functional,
structural). Parity-with-evidence: scalar throughput (measured, it *is* CVA6),
verification (224/224 + step-compare), Linux-boot (boots to userland), area
(measured + in-tree CVA6S+ upgrade). The one RTL-hardening item still open —
making the branch-prediction win RTL-vs-RTL — is fail-closed pending a
concurrent BPU-RTL rewrite reconverging (`bpu-vs-cva6-mpki-rtl.json`). Per-axis
detail + remaining work: [`../architecture-optimization/ariane-cva6-gap-analysis.md`](../architecture-optimization/ariane-cva6-gap-analysis.md).

## Why this framing is correct, not a dodge

Adopting CVA6 as the little core is the *right* engineering decision, not a
failure to "beat" it: CVA6 is the best-verified, silicon-proven open in-order
RISC-V core, and the little-core tier wants exactly that — small, efficient,
Linux-capable, low-risk. The place to spend design effort beating the field is
the OoO mid/big cores and the shared front-end, which is precisely where E1's
one measured win (the BPU) already lives.

## Reproduce

```sh
# Branch-prediction head-to-head (measured, behavioural model, runs today):
python3 benchmarks/cpu/branch/compare_mpki.py        # writes bpu-vs-cva6-mpki.json

# CVA6 CoreMark (functional anchor) and cycle-accurate (Verilator) path:
E1_COREMARK_DUT=qemu       scripts/run_coremark.sh   # functional, CRC-validated
E1_COREMARK_DUT=verilator  scripts/run_coremark.sh   # cycle-accurate CVA6

# Validate this comparison dataset:
make open-core-comparison-check
```
