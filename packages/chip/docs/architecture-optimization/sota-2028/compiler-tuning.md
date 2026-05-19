# Compiler Tuning SOTA — 2028 RISC-V Phone-Class AP

Sub-report of [2028-sota-integrated-report.md](../2028-sota-integrated-report.md).

## A. SOTA snapshot

### LLVM RISC-V backend, 2026

**RVV 1.0 codegen is real but uneven.** RVV 1.0 ratified 2021. LLVM treats it as fully supported but autovec quality is still maturing.

- **LLVM autovec on RVV gained ~9% geomean across ~16 benchmarks vs Clang from 18 months prior**, 12/16 improving 5%+ (Igalia, May 2025).
- **LLVM-19 outperforms GCC-14 on 76/151 vectorized loops** (Carpentieri PDP25 study). LLVM more sensitive to LMUL choice; both still trail hand-written intrinsics by wide margin on stride/predicated loops.
- **GCC 15 beats LLVM 21 on 4 of 6 HPC/ML proxy apps** in 2025 HPC vectorization study; both have predication-overhead and stride-load issues their cost models don't yet price correctly.
- **LMUL register pressure is dominant tuning knob**. Fractional LMUL helps high-pressure / small-tile kernels; full LMUL=8 wins for bandwidth-bound. AArch64 SVE shared VLA scaffolding matured the RVV side; IR layer is now VLA-correct, but special-cased work still happens at CodeGen.
- **Experimental Vector Crypto extensions (Zvbb, Zvbc, Zvfh)** accepted via `-menable-experimental-extensions`. Zfh, Zicboz, Zicbom, Zihintntl, Ztso, Zacas land in LLVM 19-23 progressively.

In 2026 LLVM is the canonical RVV target. Autovec is good enough as baseline but vendor-tuned-intrinsics gap on hot kernels is still 1.5x-3x on stride/predication-heavy code. Strategy: autovec everywhere, then hand-tuned intrinsics on top-N kernels.

### AutoFDO / Propeller / BOLT measured gains

- **AutoFDO alone**: ~10.5% geomean on warehouse-scale benchmarks; captures 85% of traditional FDO. Neper TCP: 6.1% throughput, 10.6% latency.
- **Propeller alone**: 1-7% over baseline on warehouse-scale apps (Shen et al ASPLOS'23).
- **AutoFDO + Propeller stacked**: ~10% throughput uplift in default Linux kernel builds; up to 10% on microbenchmarks, ~5% on warehouse-scale.
- **BOLT**: up to 7.0% on top of FDO+LTO for datacenter apps. On GCC/Clang binaries: up to 20.4% on top of FDO+LTO, up to 52.1% without FDO+LTO. Google reports 2-6% atop their own optimized binaries.
- **Machine Function Splitter** (in-tree LLVM, complements Propeller): 2.33% runtime gain, 32% iTLB miss reduction, 9.5% L1 iCache miss reduction, 20% L2 instruction miss reduction. SPECInt Clang: 0.6-1.6%.

Composable: **stacked PGO+ThinLTO+Propeller+BOLT realistically delivers 12-18% on a system image** (10% AutoFDO+Propeller, 2-6% BOLT, ~2% MFS). Linux 6.19 RISC-V Spectre mitigations cost 5-10% in tight loops, so net win for security-on builds ~5-10%.

### Android RVA23 status

- **RVA23 ratified 2024-10-21**. Vector + Hypervisor mandatory.
- **Google designated RISC-V "Tier 1" late 2025**; NDK+ABI finalized on RVA23. First commercial RISC-V smartphones early 2026.
- **Ubuntu 25.10 mandates RVA23**, obsoleting most existing RISC-V dev boards.
- **Major caveat**: April 2024 Google removed RISC-V from Android Common Kernel as primary branch; official line "not abandoning" but certified Android RISC-V devices still cautious through mid-2026.
- **hwprobe is the supported feature-discovery path**. `RISCV_HWPROBE_IMA_V` flag indicates RVV 1.0; `fence.i` may go through kernel-managed vDSO.
- **SiFive P870**: RVA23 + Vector 1.0 + Vector Crypto, explicit Android target.
- **SpacemiT K1 (X60)**: RVA22 + 256-bit RVV 1.0, ships in BPI-F3. Mainline since Linux 6.14. Not RVA23 but closest real silicon today.

### Mobile compiler stacks comparison

| Stack | License | Hardware coverage | LLM/INT4 | Open compiler? |
|---|---|---|---|---|
| **Qualcomm QNN** (Hexagon HVX/HMX) | Closed | Hexagon NPU, CPU, GPU, LPAI | INT4 weight-only via QNN profiles | No; LiteRT has direct QNN delegate |
| **MediaTek NeuroPilot** | Closed (SDK gated) | Dimensity NPU | INT4 via Compiled Model API; Google LiteRT NeuroPilot stack Dec 2025 | No |
| **Apple Core ML / ANE / SME2** | Closed | ANE (SME2 underneath per Orion paper), GPU | int8 arrays direct on iOS/macOS 26+ | No; Orion reverse-engineered private `_ANECompiler` |
| **Google IREE/MLIR** | Apache-2.0 | CPU+GPU+Vulkan+TFLite; Synaptics SL2610 Torq NPU, AMD via MLPerf SDXL Apr 2025, Coral NPU | Via StableHLO/MLIR lowerings | Yes |
| **Apache TVM (Ansor/AutoTVM)** | Apache-2.0 | Wide; MediaTek paper combined TVM+NeuroPilot | Yes via Relax | Yes |
| **PyTorch ExecuTorch** | BSD | Apple, Qualcomm, Arm, MediaTek, Vulkan, XNNPACK CPU | INT4 PT2E quantization | Yes; ships in AOSP external tree |
| **LiteRT (formerly TFLite)** | Apache-2.0 | CPU (XNNPACK), GPU, NPU (QNN, NeuroPilot), Coral | INT2/INT4 in TF 2.21 (Mar 2026) | Frontend yes; backends mixed |

For open RISC-V chip with no closed-vendor SDK to lean on, **IREE + ExecuTorch + XNNPACK is the only sane open stack**. LiteRT 2.21 reports up to 100x CPU-vs-NPU and 10x GPU-vs-NPU on supported delegates; we'd need a custom IREE backend to claim anything similar.

### RISC-V CFI (Zicfilp / Zicfiss)

- **Zicfilp**: forward-edge landing-pad `lpad` (AUIPC opcode, rd=x0). Compiler emits `lpad` on address-taken funcs and indirect-branch targets.
- **Zicfiss**: shadow-stack with `sspush`/`sspchk`/`ssrdp`/`ssamoswap`.
- **Linux user-space CFI/shadow-stack patches reached round 23+** on kernel list; ready for mainline.
- **LLVM/GCC enabling lands progressively 2025-2026**; treat as ship-ready by 2028. RVA23 includes optional Zicfilp/Zicfiss family.

### Matrix extension (AME/IME/VME)

Three competing proposals at RISC-V International:
- **IME (Integrated)** — reuses V regfile.
- **AME (Attached)** — separate matrix regfile and state; targets AI specifically.
- **VME (Vector Matrix)** — closely coupled to V, separate accumulator.

**AME data-type vote was recalled Dec 2025** for architectural pivot. **No matrix extension will be ratified in time for 2028 ship.** Matrix lives in NPU, not CPU, for at least one more product cycle. Arm SME2/Apple ANE is years ahead.

### Other relevant compiler tech

- **Spectre/SLS RISC-V**: Linux 6.19 added software Spectre mitigations for RISC-V; 5-10% overhead worst-case. Hardware mitigations still prototype.
- **Android baseline profiles**: 20-40% faster cold starts, 15-25% faster initial frame on production apps as of 2026. Since Android 14, dexopt is handled by ART Service per-architecture.
- **AWQ vs GPTQ INT4**: AWQ is default INT4 format for production inference; lower perplexity than GPTQ at 3-4 bit; 4-bit weight-only is on-device LLM standard with TinyChat 3x+ over HF FP16 on mobile GPUs.
- **FP8 E4M3**: outperforms E5M2 across configurations; covers 92.64% of workloads vs INT8 65.87%; ~40% VRAM reduction with minimal quality loss. Snapdragon 8 Elite Gen 5 markets FP8 + INT2.

## B. Current state in `packages/chip`

Evidence from these files:

- `compiler/runtime/e1_npu_runtime.py` — 660-line **Python MMIO contract enforcer**. Implements scalar ADD/SUB/MUL_LO/MAC_S16/DOT4_S8/DOT8_S4/DOT16_S2/DOT4_FP8_E4M3, packed RELU4_S8/VRELU_S8, sparse SDOT4_S4_2_4, bounded GEMM_S8/GEMM_S4 with M≤3, N≤3, K≤7 inside 64-byte scratchpad. 4-word descriptor ring with `valid_owner`, `writeback_request`, byte-count, scratch-offset packing.
- `docs/spec-db/e1-npu-runtime-contract.json` — schema `eliza.e1_npu_runtime_contract.v1`. Self-classifies as **L0 RTL UNIT**, *prototype only*, explicitly disclaims NNAPI/AIDL/phone-class TOPS/production DMA/sustained perf/MLIR-StableHLO-TFLite-ExecuTorch compiler path.
- `docs/arch/npu.md` — entire opcode ABI is single-cycle MMIO write/poll. `compiler/runtime/e1_npu_lowering.py` provides single-op lowering "smoke" for `stablehlo.dot_general`, `tflite.fully_connected`, `tflite.conv_2d`, attention-QK, attention-AV, MLP, bias-add, residual-add, transformer-block — host-side tiling stitches multiple 3x3x7 GEMM tiles. Host does im2col, transpose, requantize. **No parser, no scheduler, no graph partitioner, no delegate, no quantization calibration.**
- `docs/arch/npu-microarch.md` — planned v0: Chipyard-default Gemmini (16×16 INT8) wrapped through MMIO with 64-byte descriptor ring, `0x1002_0000` window. Implemented today: scalar fallback (`e1_npu.sv`); Gemmini wrapper "to be added".
- `docs/toolchain/riscv64-cross-host.md` — host has only **`riscv64-elf-gcc` 16.1.0 + `riscv64-elf-binutils` + QEMU 11.0.0**. No glibc cross. No LLVM/Clang for RISC-V. No ART. No NDK. No AOSP toolchain.
- `docs/architecture-optimization/software-ci.md` — 25 lines; says benchmark/AOSP/firmware claims must have real tool execution and fail-closed gates. **No compiler tuning section exists.**
- `docs/toolchain/benchmark-simulator-critical-gap-audit.md` — CoreMark/STREAM/lmbench/fio/TFLite benchmark_model/MLPerf Mobile all `planned_missing_deps` or `blocked`. Docker base not pinned. No `flake.lock`. No ELF hash archive. No PGO/AutoFDO/Propeller/BOLT tooling listed at all.
- `docs/npu/2028-targets.md` — target (160 TOPS dense INT8 peak, 80 sustained, 512 sparse INT4 peak, 18 TOPS/W). Software direction names "AIDL HAL, TFLite delegate, NNAPI, StableHLO MLIR, IREE or TVM, ExecuTorch". All future; none implemented.

`grep -r "LLVM|AutoFDO|Propeller|BOLT|ThinLTO|MLIR|IREE|TVM|ExecuTorch|PGO|LTO"` across all docs: 4 hits — benchmark matrix (ExecuTorch as Samsung Exynos competitor signal), 2028-targets aspirational list, `chipyard/circt` toolchain note, MediaTek competitor reference. **No checked-in evidence of any of these in actual build/CI flow.** No PGO profile capture script. No Propeller integration. No ThinLTO toggle. No AutoFDO collection harness. No MLIR/IREE backend dialect. No ExecuTorch lowering. No baseline profile workflow.

State: a Python MMIO contract enforcer plus aspirational competitor citations, with no compiler tuning evidence in the repo.

## C. Recommended 2028 target

### Baseline ISA

- **RVA23U64 user-space, RVA23S64 supervisor.** Mandatory per Android RISC-V ABI. Includes V (RVV 1.0), Zvfh, Zvbb, Zvkn (vector crypto), Zicbom/Zicboz, Zicfilp, Zicfiss, Zacas, Zihintntl, Ztso (optional but worth enabling), B (Zba/Zbb/Zbs).
- **VLEN = 256 bits** for application cores. Matches SpacemiT K1, meaningful autovec without enormous regfile cost. 512-bit overkill given mobile thermals; 128-bit (RVA23 floor) leaves perf on the table. Document as a contract — RVV-1.0 software is VLA but tuning code (e.g. unroll factors) wants a target VLEN.
- **ELEN = 64**. ZVL256B implication.

### Vector / Matrix split

- **CPU**: RVV 1.0 only. Intrinsics + autovec. Do not depend on AME/IME/VME for 2028 ship.
- **NPU**: matrix execution lives here. Compile through MLIR/IREE into descriptor ring + tile DMA. Existing `e1_npu` contract is right scaffold; missing piece is proper MLIR dialect (`eliza_npu`) and IREE backend emitting descriptors instead of MMIO writes one at a time.
- **GPU**: track but don't own. Mali/Adreno/IMG IP is the default. Vulkan SPIR-V autovec is via GPU driver.

### Compiler toolchain

- **LLVM trunk** as canonical RISC-V Android compiler. LLVM matches/beats GCC on most loops in 2026; AArch64-shared VLA infrastructure benefits RVV directly.
- **Clang/LLVM with**: `-O3 -mcpu=eliza-e1 -march=rva23u64 -mtune=eliza-e1 -fvectorize -flto=thin -fprofile-sample-use=<autofdo> -fbasic-block-sections=labels` then **Propeller relink** then **BOLT** on final image.
- **Stack hardening on by default**: `-fcf-protection=full` (Zicfilp/Zicfiss), `-fstack-clash-protection`, `-fsanitize=shadow-call-stack` for tagged components, `-fstack-protector-strong`. Expect 5-10% in worst-case loops, much less averaged.
- **`-fexperimental-relative-c++-abi-vtables`** for framework — saves a few MB in system images.

### NPU compiler stack

- **MLIR/IREE** as canonical NPU compiler. IREE input is StableHLO; add custom **`elizanpu` dialect** under `compiler/iree-eliza-npu/` lowering `linalg.matmul`, `linalg.conv_2d_nhwc_hwio`, attention, softmax, layer-norm, gelu/swiglu into descriptors feeding existing `submit_descriptors` ABI. Current Python `e1_npu_lowering.py` is throwaway prototype.
- **ExecuTorch as PyTorch entry**. Build custom ExecuTorch backend targeting IREE. ExecuTorch already supports Apple/Qualcomm/Arm/MediaTek/Vulkan; open RISC-V NPU is missing 13th backend.
- **LiteRT (TFLite) as second entry** via NNAPI/AIDL HAL. LiteRT 2.21+ has direct INT4 ops and direct vendor-NPU APIs; HAL must implement LiteRT AIDL surface.

### Quantization toolkit

- **PTQ INT8 (per-channel weights, per-tensor activations)** default.
- **AWQ INT4 weight-only** for LLM weights — current best practice. GPTQ kept as fallback for small-batch.
- **FP8 E4M3** for LLM weights and activations on long-context where INT8/INT4 quality loss is too high.
- **2:4 structured sparse INT4** — chip already has `SDOT4_S4_2_4` opcode. Wire into compiler's sparsity pass.
- **INT2** as experimental BitNet-class path. Repo already has `DOT16_S2`; matches Snapdragon 8 Elite Gen 5 INT2 + FP8.

### Android system image

- **Profile-guided dexopt** with cloud profiles (Google Play supplies). Document per-arch dexopt path for RISC-V — ART Service handles this since Android 14.
- **Baseline profiles in every shipping app target** — 20-40% faster cold starts is free.
- **ThinLTO on system image** — already supported in `build/soong/cc/lto.go`. Off by default; turn it on for our build.
- **AutoFDO** profile capture on representative app-launch / camera / scroll traces; feed to LLVM via `-fprofile-sample-use`.
- **Propeller** post-link relinking on framework binaries and kernel.
- **BOLT** for `system_server`, `surfaceflinger`, `zygote64`, `mediaserver`, `webview`, `chrome`. Even 2-6% on top of FDO+LTO is meaningful for power.
- **AutoFDO + Propeller on Linux kernel** — standard in Linux 6.19+ with 5-10% kernel uplift.

### Security/CFI defaults

- **Zicfilp + Zicfiss enabled** in system image — both ratified, both in mainline LLVM/Linux by 2026-2027.
- **ShadowCallStack** for Bionic/framework critical paths until Zicfiss universal.
- **Stack-Clash, BTI-equivalent landing pads, Spectre-RSB mitigation in libc and kernel** — Linux 6.19's RISC-V Spectre mitigations are the floor.

## D. Benchmarks, eval, testing

- **SPEC CPU2017** with -O3 + LTO + PGO; track regressions against `eliza-e1` per-mcpu cost model. Target geomean 5%+ above stock RVA23 baseline.
- **llvm-test-suite nightly** on RISC-V CI. Catches autovec regressions at IR-level.
- **rgo / TSVC / vector-test-suite** for autovec health checks.
- **OpenMP vectorization tests**.
- **CoreMark, STREAM, lmbench (bw_mem, lat_mem_rd), fio** — repo plans these but `planned_missing_deps`. Pin CoreMark/STREAM/lmbench/fio build recipe.
- **Android boot time, app startup (cold/warm), camera capture-to-shutter, scroll jank** under `-Os` / `-O2` / `-O3+AutoFDO` matrix. Boot time and `Activity#onCreate → first frame` are headline numbers vendors publish.
- **AOSP RISC-V CTS** where applicable — architecture-neutral suites, plus NNAPI VTS for e1-npu accelerator.
- **MLPerf Mobile v3+** with both TFLite (LiteRT) and ExecuTorch backends. Compare against Pixel/Snapdragon/Dimensity reference on MLCommons leaderboard.
- **MLPerf Tiny** for always-on micro-NPU.
- **NPU operator coverage report** per model — `unsupported_ops`, `cpu_fallback_pct`. Target hard <1% cpu_fallback for published model list.
- **ExecuTorch model conversion success rate** — Meta tracks internally; for open NPU we'd publish. Aim >90% on LiteRT/ExecuTorch reference model zoo.
- **Vectorization quality A/B** — Igalia-style benchmark suite: 16-50 kernels, geomean vs LLVM-stock and GCC-15.
- **Power/thermal traces** bound to every benchmark report (specified by `docs/npu/2028-targets.md`).

## E. Optimizations: has / should / needs

### Has
- Python MMIO contract enforcer (`e1_npu_runtime.py`) with bounded GEMM_S8/S4, scalar/packed dots, packed ReLU, sparse INT4 dot, scalar FP8 E4M3, descriptor ring with valid_owner/byte-count/scratch-offset.
- Single-op lowering "smoke" (`e1_npu_lowering.py`) for matmul/conv2d/attention-QK/attention-AV/MLP/bias-add/residual-add/transformer-block over StableHLO/TFLite *records* (not real IR).
- Host newlib `riscv64-elf-gcc 16.1.0` + QEMU 11.
- Fail-closed evidence gate model (`L0_RTL_UNIT`) with strict claim boundaries.
- Aspirational 2028 target document and dashboards.

### Should (ranked by impact)
1. **Full LLVM trunk RISC-V toolchain** with `-mcpu=eliza-e1`, RVV intrinsics headers, ThinLTO, sample-PGO, basic-block-sections; checked-in build recipe pinning LLVM SHA.
2. **Real IREE backend (`elizanpu` MLIR dialect)** consuming StableHLO/linalg and emitting descriptor ring. Replaces Python smoke with true tensor compiler.
3. **AutoFDO collection harness** running on Verilator + QEMU + (eventually) real silicon. Generate `.prof` files per workload class.
4. **Propeller relinking + BOLT post-link** integrated into Android system image and Linux kernel build.
5. **Android prebuilts for RVA23 + NDK + Bionic** glibc-cross — repo currently can't build userspace.
6. **NNAPI/AIDL HAL skeleton** wired into descriptor ring submission. Even empty AIDL HAL passing absent-device fail-closed is the gate the 2028 manifest needs.
7. **ExecuTorch RISC-V backend prototype** — for Meta-style mobile LLM deployment.
8. **Quantization toolkit** — PT2E, AWQ, GPTQ, FP8 calibration, 2:4 sparsity wired into MLIR.
9. **Baseline-profile + cloud-profile evidence path** for representative apps.

### Definitely needs
- **A real compiler backend other than a Python interpreter.** Current `e1_npu_lowering.py` cannot scale; needs MLIR/IREE.
- **Profile collection on real silicon (or cycle-accurate simulator).** Without measured profiles, AutoFDO/Propeller/BOLT are speculative.
- **CI matrix** across PDK × LLVM version × RVA23 baseline × NPU extension set. Most CI cells today blocked or missing.
- **Glibc-cross + bionic-cross toolchains in CI containers.** RISC-V userspace cannot be built on macOS host today.
- **Pinned Docker base + flake.lock + LLVM SHA + OpenLane SHA**. Audit calls this out as largest reproducibility gap.
- **Real AOSP RISC-V branch** with checked-in `manifest.xml` SHA — Google's removal of RISC-V from AOSP common kernel in 2024 needs answering with pinned branch.

## F. Risks and open questions

1. **The QNN / NeuroPilot / Core ML gap is years-deep.** Closed-vendor stacks have hand-tuned kernel libraries, in-house compilers, direct hardware backchannels. IREE+ExecuTorch is best open answer but consistently 1.5x-3x slower than vendor SDKs on like-for-like models in 2026. Pick 20-30 hot kernels (matmul tiles, fused attention, layer-norm, gelu/swiglu, depthwise conv2d, softmax) and hand-write intrinsics like ARM Compute Library does for SVE2.
2. **RVV autovec quality still lags SVE2 in LLVM.** Igalia data shows gap closing fast (9% geomean uplift in 18 months) but predication and stride loads not priced correctly. By 2027 AArch64-shared scaffolding will close most. Mitigation: RVV intrinsics for top-N hot loops; autovec for cold.
3. **Matrix extension (AME/IME/VME) will not be ratified in time for 2028 ship.** AME data-type vote recalled late 2025. Plan around RVV-1.0 + custom NPU matrix.
4. **Google's AOSP RISC-V status is volatile.** Removal from common kernel April 2024, Tier-1 designation late 2025 — but no major OEM has shipped Android RISC-V phone at Pixel scale. Pin our own AOSP RISC-V branch.
5. **Android NDK + ART RISC-V backend not fully optimized.** Google's own statement is ART RISC-V backend is "work in progress". Open question: is dexopt code-gen quality good enough on RVV-1.0 to be competitive with ARM by 2028?
6. **Linux kernel Spectre mitigations cost 5-10% on tight loops on RISC-V (6.19+).** Floor; hardware mitigations still prototype. Plan: ship with mitigations on, accept cost, push hardware mitigations into e1 microarchitecture roadmap.
7. **Current Python "lowering smoke" is debt, not asset.** Shaped like compiler interface but cannot be production — the comment "host code iterates batch/head dimensions and transposes each key matrix" inside `lower_attention_qk_smoke` is exactly host-side fix-up that must disappear. Keep Python as unit test oracle only; build MLIR/IREE for real codegen.
8. **No glibc cross-compiler on host.** Per `docs/toolchain/riscv64-cross-host.md` Homebrew has no `riscv64-linux-gnu-gcc` on darwin-arm64. Userspace can only be built in Linux container. Mandate Linux container (Docker/OrbStack) as canonical compiler env.
9. **Benchmark/simulator reproducibility broken.** Per `benchmark-simulator-critical-gap-audit.md`: Docker base moving tag, no flake.lock, no LLVM SHA, no `mobile_smoke.tflite` checksum. Compiler tuning not reproducible until pinned.
10. **No measured FP8/INT2 tensor evidence beyond scalar dots.** Contract states `DOT4_FP8_E4M3` and `DOT16_S2` are scalar-only. To hit 2028 target (80 TFLOPS FP8 peak, 900 TOPS INT2 peak) chip must add full tensor execution and compiler must lower into them. Today neither exists.

## Sources

- [Improvements to RISC-V vector code generation in LLVM (Igalia, May 2025)](https://blogs.igalia.com/compilers/2025/05/28/improvements-to-risc-v-vector-code-generation-in-llvm/)
- [RISC-V Vector Extension - LLVM 23](https://llvm.org/docs/RISCV/RISCVVectorExtension.html)
- [Autovectorization on RVV RISC-V Boards (PDP25)](https://cosenza.eu/papers/CarpentieriPDP25.pdf)
- [Register-Pressure Aware Predicator for LMUL](https://dl.acm.org/doi/fullHtml/10.1145/3547276.3548513)
- [RISC-V Vector improvements (Igalia slides)](https://www.igalia.com/downloads/slides/lukelau-alexbradbury-Improvements_to_RISC-V_Vector_code_generation_in_LLVM.pdf)
- [GCC 15 Release Series Changes](https://gcc.gnu.org/gcc-15/changes.html)
- [AutoFDO and Propeller (LWN)](https://lwn.net/Articles/995397/)
- [Google AutoFDO & Propeller Linux Kernel ~5-10% faster](https://www.phoronix.com/news/AutoFDO-Propeller-Kernel)
- [Propeller (ASPLOS'23)](https://snehasish.net/assets/pdf/shen-asplos23.pdf)
- [BOLT (arXiv)](https://arxiv.org/pdf/1807.06735)
- [BOLT - Meta Research](https://research.facebook.com/publications/bolt-a-practical-binary-optimizer-for-data-centers-and-beyond/)
- [LLVM Machine Function Splitter (D85368)](https://reviews.llvm.org/D85368)
- [LLVM MFS for 32% iTLB miss reduction](https://www.phoronix.com/news/LLVM-Lands-Machine-Func-Split)
- [Clang ThinLTO](https://clang.llvm.org/docs/ThinLTO.html)
- [Android Soong lto.go](https://cs.android.com/android/platform/superproject/+/master:build/soong/cc/lto.go)
- [RISC-V RVA23 Profile Ratification](https://riscv.org/blog/risc-v-announces-ratification-of-the-rva23-profile-standard/)
- [Ubuntu 25.10 mandates RVA23](https://www.cnx-software.com/2025/07/08/ubuntu-25-10-release-to-mandate-rva23-profile-obsoleting-most-risc-v-hardware/)
- [Android RISC-V era - Google OSS](https://opensource.googleblog.com/2023/10/android-and-risc-v-what-you-need-to-know.html)
- [Google removes RISC-V from Android Common Kernel](https://news.slashdot.org/story/24/04/30/223247/google-removes-risc-v-support-from-android-common-kernel-denies-abandoning-its-efforts)
- [RISC-V Hardware Probing Interface](https://docs.kernel.org/arch/riscv/hwprobe.html)
- [Linux 6.19 Spectre mitigations RISC-V](https://www.webpronews.com/linux-6-19-kernel-adds-spectre-mitigations-for-risc-v-cpus/)
- [RISC-V CFI for Linux (LWN)](https://lwn.net/Articles/977720/)
- [RISC-V User-Space CFI ready](https://www.phoronix.com/news/RISC-V-User-Space-CFI)
- [RISC-V CFI Backward](https://github.com/riscv/riscv-cfi/blob/main/src/cfi_backward.adoc)
- [RISC-V CFI Forward](https://github.com/riscv/riscv-cfi/blob/main/src/cfi_forward.adoc)
- [AME Ratification Plan](https://riscv.atlassian.net/wiki/spaces/AMEX/pages/55083420/AME+Ratification+Plan)
- [IME Ratification Plan](https://riscv.atlassian.net/wiki/spaces/IMEX/pages/598867969/IME+Ratification+Plan)
- [VME Ratification Plan](https://riscv.atlassian.net/wiki/spaces/VMEX/pages/663617995/Ratification+Plan)
- [IREE - MLIR-based ML compiler](https://iree.dev/)
- [TinyIREE: ML Execution Environment for Embedded](https://arxiv.org/abs/2205.14479)
- [MLIR and IREE compilers (Coral)](https://developers.google.com/coral/guides/software/mlir-iree-compilers)
- [Qualcomm AI Engine Direct / QNN SDK](https://www.qualcomm.com/developer/software/hexagon-npu-sdk)
- [QNN Execution Provider (ONNX Runtime)](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html)
- [Unlocking Peak Performance on Qualcomm NPU with LiteRT](https://developers.googleblog.com/unlocking-peak-performance-on-qualcomm-npu-with-litert/)
- [MediaTek NeuroPilot](https://neuropilot.mediatek.com/)
- [Google LiteRT NeuroPilot Stack (Dec 2025)](https://www.marktechpost.com/2025/12/09/google-litert-neuropilot-stack-turns-mediatek-dimensity-npus-into-first-class-targets-for-on-device-llms/)
- [Google LiteRT 2.21 / TF 2.21 launch (Mar 2026)](https://www.marktechpost.com/2026/03/06/google-launches-tensorflow-2-21-and-litert-faster-gpu-performance-new-npu-acceleration-and-seamless-pytorch-edge-deployment-upgrades/)
- [ExecuTorch homepage](https://executorch.ai/)
- [ExecuTorch on Android](https://docs.pytorch.org/executorch/stable/using-executorch-android.html)
- [ExecuTorch GitHub](https://github.com/pytorch/executorch)
- [Orion: Characterizing Apple's Neural Engine](https://arxiv.org/abs/2603.06728)
- [LLM Quantization Explained 2026 (VRLA Tech)](https://vrlatech.com/llm-quantization-explained-int4-int8-fp8-awq-and-gptq-in-2026/)
- [AWQ Quantization Guide](https://www.spheron.network/blog/awq-quantization-guide-llm-deployment/)
- [FP8 Across Accelerators (arXiv 2502.01070)](https://arxiv.org/html/2502.01070v1)
- [SiFive Performance P800](https://www.sifive.com/cores/performance-p800)
- [SpacemiT K1](https://www.spacemit.com/en/key-stone-k1/)
- [XNNPACK GitHub](https://github.com/google/XNNPACK)
- [Bringing XNNPACK to Qualcomm Hexagon NPU](https://www.qualcomm.com/developer/blog/2026/03/bringing-xnnpack-hexagon-npu)
- [Android Baseline Profiles](https://developer.android.com/topic/performance/baselineprofiles/overview)
- [Baseline Profiles 2026 Performance Impact](https://medium.com/@ramadan123sayed/baseline-profiles-in-android-explained-from-scratch-what-art-compilation-is-why-your-first-app-898484bf6746)
- [MLPerf Mobile Inference Benchmark](https://mlcommons.org/benchmarks/inference-mobile/)
- [NVDLA](https://nvdla.org/)
- [Gemmini paper (DAC 2021)](https://people.eecs.berkeley.edu/~ysshao/assets/papers/genc2021-dac.pdf)
- [Fuchsia RFC-0234: RVA22 + V](https://fuchsia.dev/fuchsia-src/contribute/governance/rfcs/0234_riscv_abi_rva22+v)
