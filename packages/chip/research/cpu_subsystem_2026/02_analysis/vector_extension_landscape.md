# RISC-V Vector (RVV 1.0) open implementations and fit for Eliza E1

Date: 2026-05-19

The NPU is the primary tensor path for E1. Vectors are not a replacement.
Their role on E1 is:

- CPU fallback for operators the NPU cannot run (the
  `compute-silicon.md` P1 work order calls this out explicitly).
- SIMD math for non-NN code (codecs, DSP, classical CV, encryption,
  string/byte primitives).
- A safety net so a missing NPU operator does not collapse to scalar.

The open RVV 1.0 landscape splits into two families: vector units bolted
to an existing scalar core, and decoupled vector engines that issue from
the scalar core to a separate datapath.

## Comparison matrix

| Implementation | Host core | DLEN (bits) | RVV version | License | Coupling | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| **Saturn** (UCB-BAR) | Rocket / BOOM | up to 1024 (parameterized) | RVV 1.0 | BSD-3-Clause | decoupled OoO, Chipyard-native | First-class fit with current Chipyard selection. |
| **Spatz** (PULP) | Snitch | 256-1024 | RVV 1.0 lite | Apache-2.0 / Solderpad | tightly-coupled cluster | Energy-efficient; not a Chipyard drop-in. |
| **Ara2** (PULP) | CVA6 | up to 4096 | RVV 1.0 | Apache-2.0 / Solderpad | decoupled scoreboard | Highest FPU utilization in published runs; CVA6-bound. |
| **OpenC908** | C908 in-order | 128 | RVV 1.0 | Apache-2.0 | tightly coupled | Production-class but XuanTie-specific. |
| **CVA6-V** | CVA6 | parameterized | RVV 1.0 (in progress) | Solderpad-2.1 | tightly coupled | OpenHW upstream effort. |
| **XiangShan KunMingHu vector** | KunMingHu OoO | 128/256 | RVV 1.0 + Zvbb + Zvkn | Mulan-PSL-v2 | OoO integrated | Highest performance; largest area. |
| **OpenC910 / OpenC920 vector** | C910/C920 OoO | 128 | RVV 0.7.1 | Apache-2.0 | OoO integrated | Pre-1.0; not Android RV compatible. |
| **Hwacha** (historic) | Rocket | parameterized | pre-RVV | BSD-3-Clause | decoupled | Reference only; predates RVV 1.0. |
| **Vicuna** | LowRISC Ibex | 128 | RVV 1.0 (subset) | Solderpad | tightly coupled | Embedded class; useful for management-core SIMD. |

## Detailed assessment

### Saturn (recommended)

- Decoupled vector engine that issues from Rocket or BOOM through a
  dedicated vector decoder.
- DLEN parameter exposes a clean perf/area knob without forcing scalar
  pipeline rework.
- RVV 1.0 with Zve* subset selection.
- Already in Chipyard releases tracked by our pinned 1.13.0 commit, so the
  integration cost is bounded.
- Risk: relatively young; production tapeout evidence is limited compared
  to Ara2 or XiangShan's vector unit.

### Spatz + Snitch

- Different SoC philosophy: clusters of tiny scalar cores driving a vector
  unit per cluster, optimized for sustained MAC throughput on tight loops.
- Not architecturally aligned with E1's NPU-first plan because Spatz
  duplicates NPU strengths and weakens the CPU-fallback story.
- Track only.

### Ara2

- Strongest decoupled vector engine in the open ecosystem on FPU
  utilization metrics.
- Requires CVA6 as the host hart. Picking Ara2 also implies replacing
  Rocket with CVA6.
- Best candidate if E1 ever moves off Chipyard onto a Cheshire/Carfield
  scaffold.

### XuanTie OpenC908 / OpenC910 / OpenC920

- C908 is the only XuanTie public core that is RVV 1.0 today.
- C910/C920 ship in production silicon but are RVV 0.7.1 only. The Android
  RV ABI requires RVV 1.0 (RVA22 + V or RVA23). Software-stack
  compatibility is the dominant risk.
- Useful as reference implementations for vector LSU, vector trap, and
  vector context-switch handling.

### XiangShan KunMingHu vector

- Highest-performance open RVV 1.0 implementation in 2026.
- Implements Zvbb (bitmanip vector) and Zvkn (NIST AES vector) on top of
  RVV 1.0 base, which is what crypto-heavy workloads need.
- Inseparable from the KunMingHu core itself; not portable to Rocket.

### Hwacha

- Historical Rocket-based vector engine. Predates RVV 1.0. Should not be
  selected for new work; useful only for educational purposes.

### Vicuna

- Embedded RVV 1.0 subset attached to Ibex. Relevant only if the
  management/security cluster needs SIMD primitives (it does not in the
  current E1 plan).

## Vector software stack implications

| Concern | Required for Android RV on E1 |
| --- | --- |
| ABI | LP64D + V (RVA22+V) is the Android RV reference. |
| Toolchain | LLVM 17+ with RVV 1.0 autovectorizer + GCC 14+ vector intrinsics. |
| Kernel | Linux 6.5+ for in-kernel V save/restore, Sscofpmf, Sstc. |
| Runtime | Bionic libc + libcompiler_rt with V routines (Google upstream). |
| Crypto | OpenSSL/BoringSSL Zvkn paths (in progress). |
| ML | XNNPACK and TFLite have draft RVV 1.0 micro-kernels; CPU fallback for the NPU should target XNNPACK first. |

## Recommendation

For Eliza E1 vector fallback alongside the NPU:

1. Track Saturn as the default vector engine for the Chipyard path. Defer
   integration until after Rocket Linux gates pass.
2. Hold Spatz and Ara2 as alternates tied to non-Chipyard SoC choices.
3. Treat XuanTie cores as software-stack references, not RTL imports.
4. Require RVV 1.0 (not 0.7.1) for any vector claim that touches Android.
5. Bind the vector path to the NPU operator-coverage fallback metric in
   `docs/architecture-optimization/compute-silicon.md` (P1 work item:
   "Add NPU operator coverage only with unsupported op count and CPU
   fallback percentage"). The CPU fallback % must be computed against a
   vector-capable scalar path, not Rocket scalar.
