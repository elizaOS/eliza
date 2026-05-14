# Eliza-1 device support gap analysis — 2026-05-10

> Superseded status note, 2026-05-11: keep this file as historical context.
> The current blocker ledger is
> `packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`.
> Since this audit, Vulkan standalone QJL/Polar verification was added on
> Apple M4 Max via MoltenVK, Metal `GGML_OP_ATTN_SCORE_QJL` graph dispatch
> became runtime-ready, the build gate was tightened so `turbo3_tcq` is
> required alongside `turbo3`, `turbo4`, QJL, Polar, and DFlash, and the
> Vulkan follow-up now has explicit native Linux / Android smoke entrypoints.
> Do not use the target rows below as current publish criteria; they predate
> the target-keyed release evidence gate and some are intentionally stale.

Scope: every (tier × backend × OS × arch) combination implied by
[`AGENTS.md`](AGENTS.md) §2/§3 and the build matrix in
[`packages/app-core/scripts/build-llama-cpp-dflash.mjs`](../app-core/scripts/build-llama-cpp-dflash.mjs)
(`SUPPORTED_TARGETS`, lines 82–109).

The matrix in [`README.md`](README.md) covers shader×backend verification
of the five kernels (turbo3 / turbo4 / turbo3_tcq / qjl / polar) on the
two backends an engineer has actually run them on. This document is the
complementary view: where each *device class* stands today against the
Eliza-1 contract.

Status legend (do not soften):

- **VERIFIED** — kernel suite ran on real hardware of this exact class
  with `metal_verify` / `vulkan_verify` 8/8 PASS, evidence cited.
- **VERIFIED-ADJACENT** — verified on a different chip in the same
  GPU/driver family; high confidence the verified result transfers, but
  not yet observed.
- **COMPILE-ONLY** — build target produces a non-zero artifact on a
  developer host, but the artifact has not been loaded on the device
  class.
- **TARGET-ONLY** — build target name is in `SUPPORTED_TARGETS` but
  nothing has been observed running through it end-to-end on this OS
  pair (no published artifact, no on-device run record).
- **BLOCKED** — known prerequisite missing (host, SDK, harness).
- **NO-TARGET** — there is no entry in `SUPPORTED_TARGETS` for this
  device class at all.

---

## 1. Device matrix

| # | Device class                                  | Tier(s) implicated     | Backend  | Build target                              | Status                  | Evidence / blocker                                                                                                                                                                                                                                                            |
|---|-----------------------------------------------|------------------------|----------|-------------------------------------------|-------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1 | Apple Silicon Mac, M4 Max                     | 9b, 27b    | metal    | `darwin-arm64-metal`                      | **VERIFIED**            | [`README.md` lines 7–10, 308–312](README.md); [`bench_M4Max_2026-05-10.md`](bench_M4Max_2026-05-10.md). 5/5 shaders 8/8 PASS via `MTLDevice.newLibraryWithSource` (Wave-3, Darwin 25.2.0).                                                                                     |
| 2 | Apple Silicon Mac, M1 / M2 / M3               | 9b, 27b    | metal    | `darwin-arm64-metal`                      | **VERIFIED-ADJACENT**   | Same Apple GPU family, Metal 3 / Family-Apple7+, same 32-thread SIMD-group assumption ([`README.md` line 51, 209–212](README.md)). Untested on M1/M2/M3; should retest before flipping `defaultEligible: true` on the desktop manifest for these chips.                        |
| 4 | iOS arm64 (iPhone 14+)                        | 0_6b, 1_7b | metal    | `ios-arm64-metal`                         | **PARTIALLY-RESOLVED** | `run-mobile-build.mjs ensureIosLlamaCppVendoredFramework()` delegates to `build-llama-cpp-dflash.mjs --target ios-arm64-metal`, then `ios-xcframework/build-xcframework.mjs --verify` fills `LlamaCpp.xcframework`. The Metal EMBED path is now patched to ship the same standalone metallib symbols as desktop. A physical-device XCTest entrypoint now exists at `packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs` and hard-fails when no real iPhone/iPad is attached. **Still missing:** an actual on-device PASS and runtime-ready capability bits for Turbo/Polar graph dispatch. |
| 5 | iOS arm64 simulator (Apple Silicon Mac)       | 0_6b, 1_7b | metal    | `ios-arm64-simulator-metal`               | **PARTIALLY-RESOLVED** | Same packaging path as row 4 for the simulator slice. Symbol shipping is not enough for publish eligibility; the remaining blocker is the same graph-dispatch/device-smoke gap. |
| 6 | Android arm64 (Adreno 6xx+ / Mali-G7x+)       | 0_6b, 1_7b | vulkan   | `android-arm64-vulkan`                    | **COMPILE-ONLY**        | Build target exists, NDK toolchain wired. `applyForkPatches` now folds the QJL TUs into `ggml-base` for `android-*` too (the `libggml-base.so` link was failing on undefined `quantize_qjl1_256` without it), so `android-arm64-vulkan` builds clean (all kernels detected) from a Linux host with `~/Android/Sdk/ndk`. Verified compiled 2026-05-11. Vulkan turbo* shaders verified on Mesa lavapipe + Intel ARL only; **no on-device Adreno/Mali graph-dispatch run** — see `android-vulkan-smoke` make target. Android API floor `android-28`. |
| 7 | Android arm64 (CPU fallback)                  | 0_6b              | cpu      | `android-arm64-cpu`                       | **TARGET-ONLY**         | Build target exists; same QJL-in-`ggml-base` fix applies. Runtime CPU NEON paths from `qjl-cpu` / `polarquant-cpu`. No on-device Snapdragon/Tensor run logged.                                                                                                            |
| 8 | Linux x64 + NVIDIA (RTX/A100/Blackwell)      | 9b, 27b, 27b-256k | cuda  | `linux-x64-cuda`                          | **TARGET-ONLY**         | Triple compiles; `-DGGML_CUDA_FA=ON -DGGML_CUDA_FA_ALL_QUANTS=ON` set. `CMAKE_CUDA_ARCHITECTURES` now pinned to a fat-binary list (`90a;90;89;86;80`, plus Blackwell `100;120` when `nvcc >= 12.8`) via `cudaArchListFlag()` — no longer relies on the host-probe default. No CUDA host in lab; W4-B CUDA QJL/Polar/TBQ3_TCQ kernels unverified end-to-end. Hardware runner: `verify/cuda_runner.sh --report <path>`.        |
| 9 | Linux x64 + AMD (MI300 / MI250 / RX 7000/9000) | 9b, 27b    | rocm   | `linux-x64-rocm`                          | **TARGET-ONLY**         | Triple compiles when `hipcc`/`rocminfo` present. `CMAKE_HIP_ARCHITECTURES` now pinned to `gfx90a;gfx942;gfx1100;gfx1101;gfx1102` (plus RDNA4 `gfx1200;gfx1201` when HIP >= 6.3) via `hipArchListFlag()`. No ROCm host in lab; QJL/Polar HIP path inherits from CUDA via hipify and is unverified. Hardware runner: `verify/rocm_runner.sh`.                                                              |
| 10 | Linux x64 + Intel/AMD/NVIDIA (Vulkan)         | 1_7b → 27b             | vulkan   | `linux-x64-vulkan`                        | **PARTIAL VERIFIED**    | Standalone Vulkan harness now covers all five kernels. turbo3 / turbo4 / turbo3_tcq: VERIFIED on Intel ARL Mesa 25.2.8 + lavapipe. qjl / polar: VERIFIED on Apple M4 Max via MoltenVK 1.4.1. **Still missing:** native Linux Intel/AMD/NVIDIA runtime graph dispatch smoke; MoltenVK is not a substitute for native desktop drivers. |
| 11 | Linux x64 (CPU)                               | all                    | cpu      | `linux-x64-cpu`                           | **VERIFIED (reference)** | `verify/gen_fixture --self-test` passes on host with QJL/Polar reference parity checks ([`README.md` lines 322–334](README.md)). This verifies the C reference, not a particular x86 SIMD path. AVX2/NEON dispatch in `qjl-cpu`/`polarquant-cpu` not separately benched here. Build re-verified clean 2026-05-11 (then hard-fails the kernel-completeness gate as designed — CPU has no Turbo/QJL/Polar GPU kernels).   |
| 12 | Linux aarch64 (GH200, Ampere Altra, Graviton) | 27b-256k            | cpu / cuda | `linux-aarch64-cpu` / `linux-aarch64-cuda` | **TARGET-ONLY**        | Triples now in `SUPPORTED_TARGETS`. `cmakeFlagsForTarget` adds `-DCMAKE_SYSTEM_PROCESSOR=aarch64`; the CUDA arch list leads with `sm_90a` for GH200/Hopper. **Requires a real arm64 Linux host** — `targetCompatibility()` refuses the triple on x64 hosts (no aarch64 cross-toolchain wired). Hardware runner: `verify/gh200_runner.sh --report <path>` (requires arm64 Linux + Hopper). Unblocks the `27b-256k` tier's canonical single-binary GH200 deployment.                                              |
| 13 | Windows x64 (CPU)                             | 9b, 27b    | cpu      | `windows-x64-cpu`                         | **COMPILE-VERIFIED**    | Cross-compile via x86_64-w64-mingw32 wired, with `patchGgmlBaseForWindowsQjl` to fix QJL symbol-resolution under PE/COFF. Build re-verified clean 2026-05-11 from a Linux host (mingw on PATH; the `~/.local/x86_64-w64-mingw32` extracted-deb install must be on PATH at build time because CMake's static-archive rule emits a bare `x86_64-w64-mingw32-ar`). **Not run on a Windows host;** AVX2 `qjl_quantize_avx2.c` SIMD path on Windows untested.                                |
| 14 | Windows x64 (CUDA)                            | 9b, 27b    | cuda     | `windows-x64-cuda`                        | **TARGET-ONLY**         | Triple in `SUPPORTED_TARGETS`; CUDA arch list pinned via `cudaArchListFlag()` (same fat-binary list as Linux). No native Windows + CUDA host in lab. Cross from Linux is not implemented (mingw doesn't host nvcc). Hardware runner: `verify/windows_runner.ps1 -Backend cuda`.                       |
| 15 | Windows x64 / arm64 (generic GPU / Vulkan)    | 1_7b → 27b | vulkan   | `windows-x64-vulkan` / `windows-arm64-vulkan` | **TARGET-ONLY**     | `windows-x64-vulkan` cross-builds from Linux/Darwin via mingw + Khronos Vulkan-Headers (same shape as `windows-x64-cpu` plus the Vulkan-headers prep). `windows-arm64-vulkan` (Snapdragon X / Copilot+ PC, Adreno X1) needs a native MSVC arm64 host (`-A ARM64`) or `MINGW_TOOLCHAIN_FILE` pointing at a clang/LLVM `aarch64-w64-mingw32` toolchain — the bundled mingw discovery only handles `x86_64-w64-mingw32`. No native Windows Vulkan run logged. Hardware runner: `verify/windows_runner.ps1 -Backend vulkan`. |
| 16 | Windows arm64 (Snapdragon X / Copilot+ PC, CPU) | 1_7b, 9b | cpu     | `windows-arm64-cpu`                       | **TARGET-ONLY**         | Triple in `SUPPORTED_TARGETS`; `cmakeFlagsForTarget` enables the ARMv8.4 NEON paths from `qjl-cpu`/`polarquant-cpu`. Same arm64 toolchain requirement as row 15. No on-device run logged.                                                                                                     |
| 17 | WebGPU (any browser)                          | 0_6b, 1_7b | webgpu   | **NONE**                                  | **NO-TARGET**           | llama.cpp upstream has a WebGPU backend in progress; no `*-webgpu` triple, no WGSL ports of turbo*/qjl/polar. Out of scope for ship-1 unless mandated.                                                                                                                          |

### Sub-row: per-kernel status on the two verified backends

For completeness — this is the [`README.md`](README.md) matrix re-stated
in this document's status vocabulary:

| Backend | turbo3      | turbo4      | turbo3_tcq  | qjl                          | polar                        |
|---------|-------------|-------------|-------------|------------------------------|------------------------------|
| Metal (M4 Max) | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| Vulkan (Intel ARL + lavapipe) | VERIFIED | VERIFIED | VERIFIED | NOT RUN on that ICD | NOT RUN on that ICD |
| Vulkan (Apple M4 Max via MoltenVK) | VERIFIED | VERIFIED | VERIFIED for `qjl.comp` score only; fallback `qjl_get_rows`/`qjl_mul_mv` compile-only | VERIFIED for `polar.comp` matvec only; fallback `polar_get_rows` compile-only |
| CUDA / ROCm | TARGET-ONLY | TARGET-ONLY | TARGET-ONLY | TARGET-ONLY | TARGET-ONLY |

---

## 2. Top 5 blockers (ranked by user-impact)

1. **iOS path is orphaned.** ~~RESOLVED IN WIRING (Wave-4-F)~~ — see
   `packages/app-core/scripts/ios-xcframework/README.md`. The
   `--target ios-arm64-metal` and `--target ios-arm64-simulator-metal`
   archives are now glued into `LlamaCpp.xcframework` by
   `ios-xcframework/build-xcframework.mjs`, invoked from
   `run-mobile-build.mjs ensureIosLlamaCppVendoredFramework()`. The
   stock npm-bundled framework is archived out of `FRAMEWORK_SEARCH_PATHS`.
   The EMBED metallib branch is patched now. **Residual:** run
   `ios-xcframework/run-physical-device-smoke.mjs` on physical hardware
   and keep publish blocked until the same runtime-ready graph capability
   bits as desktop are true.
   Owner: device-lab (real-iPhone XCTest harness) + kernel team (remaining graph dispatch).
   Effort: S (XCTest harness) + M (dispatch parity).

2. **`linux-aarch64-*` target = GH200 / `27b-256k` path.**
   ~~RESOLVED IN WIRING (2026-05-11)~~ — `linux-aarch64-cpu` and
   `linux-aarch64-cuda` are now in `SUPPORTED_TARGETS`,
   `cmakeFlagsForTarget` adds `-DCMAKE_SYSTEM_PROCESSOR=aarch64` and the
   CUDA arch list leads with `sm_90a` for GH200/Hopper. `targetCompatibility()`
   gates the triple on a real arm64 Linux host (no aarch64 cross-toolchain
   is wired here on purpose — run on a real arm64 build runner / the GH200
   itself). **Residual:** an actual build + `cuda_verify` / `gh200_runner.sh`
   PASS on a real GH200; nothing has run through this triple end-to-end yet.
   Owner: device-lab (GH200 runner).
   Effort: M (verification on real GH200).

3. **Vulkan graph dispatch gap.** The standalone Vulkan harness gap is
   resolved: `vulkan_verify` now branches on QJL and Polar fixtures and
   passes all five kernels on Apple M4 Max via MoltenVK. The remaining
   blocker is runtime graph dispatch in the fork: `ggml-vulkan.cpp` still
   needs eliza-native descriptors/push constants and per-op routing before
   a `linux-x64-vulkan` or Android build can honestly claim runtime-ready
   QJL/Polar/TurboQuant.
   Owner: kernel team (backend dispatch patch + native-driver smoke).
   Effort: M–L depending on Vulkan backend surface.

4. **No CUDA hardware in the loop.** `linux-x64-cuda` and the
   v0.4.0-eliza fork's W4-B CUDA QJL/Polar/TBQ3_TCQ kernels have never
   been observed running on a real NVIDIA card in this repo. The build
   target compiles when `nvcc` is present
   ([`build-llama-cpp-dflash.mjs:812`](../app-core/scripts/build-llama-cpp-dflash.mjs))
   but `metal_verify`/`vulkan_verify` style numerical parity checks have
   no CUDA equivalent in `verify/`. AGENTS.md §8 requires *"the CUDA
   path (where applicable) reproduces the same outputs to the same
   numerical tolerance"*. Today this is a paper claim. Blocks
   `9b`, `27b`, `27b-256k`.
   Owner: device-lab + kernel team.
   Effort: M (write `cuda_verify` harness against same JSON fixtures) →
   L (procure a host or a CI runner).

5. **iOS Capacitor patch claims the xcframework slot but the eliza
   archive never lands there.** ~~RESOLVED IN WIRING (Wave-4-F)~~ — the
   `buildIosLlamaCppSimulatorFramework()` in-process cmake call is gone.
   `ensureIosLlamaCppVendoredFramework()` now invokes
   `build-llama-cpp-dflash.mjs --target ios-arm64-{metal,simulator-metal}`
   and pipes the produced `libllama.a` / `libggml*.a` / public headers
   through `ios-xcframework/build-xcframework.mjs --verify`. The
   patched podspec still points at the same
   `ios/Frameworks-xcframework/LlamaCpp.xcframework` slot, but the slot
   is now filled with the eliza-kernel xcframework, not a stock build.
   Pairs with blocker #1's residual runtime-dispatch/device-smoke gap.
   Owner: device-lab + kernel team.
   Effort: S–M.

---

## 3. Top 5 quick wins (S-effort, high impact)

1. **Add Vulkan runtime graph dispatch for QJL.** Reuse the verified
   `qjl.comp` push layout (`n_heads`, `n_kv_heads`, `n_tokens`,
   `proj_dim`) but route it from a real graph op instead of the standalone
   harness. Acceptance is a built-fork smoke test, not symbol presence.
   Owner: kernel team.

2. **Add Vulkan runtime graph dispatch for PolarQuant.** Route the verified
   `polar.comp` / `polar_get_rows.comp` layouts from graph execution and
   cover both `use_qjl=0` and `use_qjl=1` in a built-fork smoke.
   Owner: kernel team.

3. **Pin `CMAKE_CUDA_ARCHITECTURES`.** ~~DONE (2026-05-11)~~ — the cuda
   branch in `cmakeFlagsForTarget` now emits `cudaArchListFlag()` =
   `-DCMAKE_CUDA_ARCHITECTURES=90a;90;89;86;80` (Ampere → Hopper), and
   appends Blackwell `100;120` when the installed `nvcc` reports
   `>= 12.8` (older toolkits reject `sm_100`/`sm_120`). Same idea for HIP
   via `hipArchListFlag()` (RDNA4 `gfx1200;gfx1201` gated on HIP `>= 6.3`).
   Operators still override via `ELIZA_DFLASH_CMAKE_FLAGS`.

4. **Add `windows-arm64-cpu` and `windows-arm64-vulkan` to
   `SUPPORTED_TARGETS`.** ~~DONE (2026-05-11)~~ — both triples are in
   `SUPPORTED_TARGETS`. `cmakeFlagsForTarget` handles `-A ARM64` on a
   native MSVC arm64 host and otherwise expects `MINGW_TOOLCHAIN_FILE`
   pointing at a clang/LLVM `aarch64-w64-mingw32` toolchain; the
   `backend === "cpu" && arch === "arm64"` block keeps the ARMv8.4 NEON
   paths from `qjl-cpu`/`polarquant-cpu` on. `windows-x64-vulkan` was
   also added (generic-GPU x64 Windows via mingw + Khronos headers).
   **Residual:** a real Snapdragon X build + run; nothing has run through
   either arm64 triple. Owner: device-lab.

---

## 4. `verify/` harness extension roadmap (historical; current status)

See [`verify/ROADMAP.md`](verify/ROADMAP.md) for the historical plan and
[`reports/porting/2026-05-11/remaining-work-ledger.md`](reports/porting/2026-05-11/remaining-work-ledger.md)
for the current blocker ledger. The Vulkan QJL/Polar harness extensions and
the CUDA verifier scaffold now exist; the remaining gaps are runtime graph
dispatch and real device runs.

- **vulkan_verify QJL bind-set** — RESOLVED. Branches on `fx.kernel`, allocates
  `q_sketch[n_heads*256]` + `packed_k[n_kv_heads*n_tokens*34]` +
  `scores[n_heads*n_tokens]`, and pushes 4 uints.

- **vulkan_verify Polar bind-set** — RESOLVED. Branches, allocates
  `k_blocks[n_rows*82]` + `q[head_dim]` + `y[n_rows]`, push 3 uints.
  Covers both `use_qjl=0` and `use_qjl=1` via `polar.json` and
  `polar_qjl.json`.

- **`cuda_verify`** — SCAFFOLD EXISTS. Same JSON fixture format,
  `cudaMalloc` + `cudaMemcpy` instead of vulkan_verify's host-visible
  path, kernel launch via the v0.4.0-eliza fork's CUDA entry points
  (`turbo_quant_cuda.cuh`, the W4-B QJL/Polar/TBQ3_TCQ additions). Needs
  a real CUDA host for the first 8/8 run.

- **Adreno on-device runner** — cross-compile `vulkan_verify` against
  the NDK Vulkan headers (already wired in `cmakeFlagsForTarget`),
  `adb push` the SPIR-V + fixtures + binary, run on a Pixel-class device
  (Adreno 730+) or Galaxy S24 (Adreno 750). Same fixtures, no new code.

- **Mali on-device runner** — same as Adreno but on a Pixel-Tensor /
  Galaxy non-Snapdragon device (Mali-G715+). Mali subgroup behavior
  differs from Adreno on `subgroupAdd`; the W4-A shared-mem tree
  reduction sidesteps that, but it still needs a real run to confirm.

- **iOS device runner** — `ios-xcframework/run-physical-device-smoke.mjs`
  now builds a temporary SwiftPM XCTest package and runs it via
  `xcodebuild test -destination "platform=iOS,id=…"`. It validates
  physical-device Metal availability plus LlamaCpp, QJL, Polar, DFlash,
  and `libelizainference` ABI symbols. It still needs a real attached
  iPhone/iPad run before row 4 can move beyond PARTIALLY-RESOLVED.

- **`linux-aarch64-cuda` (GH200) target + verify** — add the triple to
  `SUPPORTED_TARGETS`, add `-DCMAKE_SYSTEM_PROCESSOR=aarch64
  -DCMAKE_CUDA_ARCHITECTURES=90a` to the cmake flags, then run the new
  `cuda_verify` (above) on the GH200.

- **AMD ROCm verify** — `cuda_verify`'s sources hipify cleanly to HIP;
  run the resulting binary on an MI250/MI300 host. The W4-B kernels
  ship CUDA-only today; ROCm parity is unverified.

---

## 5. Notes on rows that surprised the author

- `linux-x64-vulkan` *being* "PARTIAL VERIFIED" — the README is right,
  but worth restating: the Vulkan turbo* result on Intel ARL +
  lavapipe is the only non-Metal hardware result anywhere in this
  repo. Every other "Vulkan works" claim in the codebase derives from
  this single bench.

- Intel Macs (`darwin-x64-metal`) are not a supported target — Intel Mac
  dGPUs are AMD Radeon Pro / Intel Iris, a different GPU family from Apple
  Silicon with different SIMD-group sizes and `simd_sum` semantics, so the
  M4 Max Metal result does not transfer. Apple Silicon `darwin-arm64-metal`
  is the only supported macOS target.

- `windows-x64-cpu` is fully cross-compileable from Linux but no Windows
  host has actually run the produced exe. The `patchGgmlBaseForWindowsQjl`
  pre-build step at `build-llama-cpp-dflash.mjs:439–485` exists
  precisely because someone tried, hit the PE/COFF unresolved-symbol
  failure, and patched around it — so we know the build link-completes,
  but execution semantics on Windows are still unknown.
