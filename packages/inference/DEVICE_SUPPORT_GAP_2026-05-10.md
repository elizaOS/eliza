# Eliza-1 device support gap analysis — 2026-05-10

> Superseded status note, 2026-05-11: keep this file as historical context.
> The current blocker ledger is
> `packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`.
> Since this audit, Vulkan standalone QJL/Polar verification was added on
> Apple M4 Max via MoltenVK, Metal `GGML_OP_ATTN_SCORE_QJL` graph dispatch
> became runtime-ready, the build gate was tightened so `turbo3_tcq` is
> required alongside `turbo3`, `turbo4`, QJL, Polar, and DFlash, and the
> Vulkan follow-up now has explicit native Linux / Android smoke entrypoints.

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
| 3 | Intel/AMD Mac (x64 + AMD/Intel GPU)           | 9b             | metal    | `darwin-x64-metal`                        | **TARGET-ONLY**         | Triple parses ([`build-llama-cpp-dflash.mjs:90`](../app-core/scripts/build-llama-cpp-dflash.mjs)) and `cmakeFlagsForTarget` honors it, but no Intel-Mac hardware in lab. AMD Radeon Pro / Intel Iris Metal driver behavior on `simd_sum` over 32-lane TG is **not** verified.  |
| 4 | iOS arm64 (iPhone 14+)                        | 0_6b, 1_7b | metal    | `ios-arm64-metal`                         | **PARTIALLY-RESOLVED** | `run-mobile-build.mjs ensureIosLlamaCppVendoredFramework()` delegates to `build-llama-cpp-dflash.mjs --target ios-arm64-metal`, then `ios-xcframework/build-xcframework.mjs --verify` fills `LlamaCpp.xcframework`. The Metal EMBED path is now patched to ship the same standalone metallib symbols as desktop. A physical-device XCTest entrypoint now exists at `packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs` and hard-fails when no real iPhone/iPad is attached. **Still missing:** an actual on-device PASS and runtime-ready capability bits for Turbo/Polar graph dispatch. |
| 5 | iOS arm64 simulator (Apple Silicon Mac)       | 0_6b, 1_7b | metal    | `ios-arm64-simulator-metal`               | **PARTIALLY-RESOLVED** | Same packaging path as row 4 for the simulator slice. Symbol shipping is not enough for publish eligibility; the remaining blocker is the same graph-dispatch/device-smoke gap. |
| 6 | Android arm64 (Adreno 6xx+ / Mali-G7x+)       | 0_6b, 1_7b | vulkan   | `android-arm64-vulkan`                    | **TARGET-ONLY**         | Build target exists, NDK toolchain wired ([`build-llama-cpp-dflash.mjs:670–689`](../app-core/scripts/build-llama-cpp-dflash.mjs)). Vulkan turbo* shaders verified on Mesa lavapipe + Intel ARL only. **No on-device Adreno/Mali run.** Android API floor `android-28` (line 680). |
| 7 | Android arm64 (CPU fallback)                  | 0_6b              | cpu      | `android-arm64-cpu`                       | **TARGET-ONLY**         | Build target exists; runtime CPU NEON paths from `qjl-cpu` / `polarquant-cpu` referenced in `patchGgmlBaseForWindowsQjl`. No on-device Snapdragon/Tensor run logged.                                                                                                            |
| 8 | Linux x64 + NVIDIA (RTX/A100)                 | 9b, 27b    | cuda     | `linux-x64-cuda`                          | **TARGET-ONLY**         | Triple compiles; `-DGGML_CUDA_FA=ON -DGGML_CUDA_FA_ALL_QUANTS=ON` set ([`build-llama-cpp-dflash.mjs:638`](../app-core/scripts/build-llama-cpp-dflash.mjs)). No `CMAKE_CUDA_ARCHITECTURES` pin (relies on llama.cpp default = host probe / native). No CUDA host in lab; W4-B CUDA QJL/Polar/TBQ3_TCQ kernels in v0.4.0-milady fork are unverified end-to-end.        |
| 9 | Linux x64 + AMD (MI300 / MI250 / RX 7000)     | 9b, 27b    | rocm     | `linux-x64-rocm`                          | **TARGET-ONLY**         | Triple compiles when `hipcc`/`rocminfo` present. `-DGGML_HIP=ON` only — no AMD GPU arch pin (`GFX942`, `GFX1100`, etc.). No ROCm host in lab; QJL/Polar HIP path inherits from CUDA via hipify and is unverified.                                                              |
| 10 | Linux x64 + Intel/AMD/NVIDIA (Vulkan)         | 1_7b → 27b             | vulkan   | `linux-x64-vulkan`                        | **PARTIAL VERIFIED**    | Standalone Vulkan harness now covers all five kernels. turbo3 / turbo4 / turbo3_tcq: VERIFIED on Intel ARL Mesa 25.2.8 + lavapipe. qjl / polar: VERIFIED on Apple M4 Max via MoltenVK 1.4.1. **Still missing:** native Linux Intel/AMD/NVIDIA runtime graph dispatch smoke; MoltenVK is not a substitute for native desktop drivers. |
| 11 | Linux x64 (CPU)                               | all                    | cpu      | `linux-x64-cpu`                           | **VERIFIED (reference)** | `verify/gen_fixture --self-test` passes on host with QJL/Polar reference parity checks ([`README.md` lines 322–334](README.md)). This verifies the C reference, not a particular x86 SIMD path. AVX2/NEON dispatch in `qjl-cpu`/`polarquant-cpu` not separately benched here.   |
| 12 | Linux aarch64 (GH200, Ampere Altra, Graviton) | 27b-256k            | cpu / cuda | **NONE**                                | **NO-TARGET**           | `SUPPORTED_TARGETS` ([`build-llama-cpp-dflash.mjs:82–109`](../app-core/scripts/build-llama-cpp-dflash.mjs)) has no `linux-aarch64-*` entry. GH200 has aarch64 CPU + H100/H200 GPU; the H100/H200 GPU half *might* work via `linux-x64-cuda` if you put a discrete x64 launcher in front of it, but the canonical GH200 deployment is single-binary aarch64 host + sm_90a CUDA. **Hard miss for the `27b-256k` tier.**                                              |
| 13 | Windows x64 (CPU)                             | 9b, 27b    | cpu      | `windows-x64-cpu`                         | **COMPILE-ONLY**        | Cross-compile via x86_64-w64-mingw32 wired ([`build-llama-cpp-dflash.mjs:285–417, 690–734`](../app-core/scripts/build-llama-cpp-dflash.mjs)) with `patchGgmlBaseForWindowsQjl` to fix QJL symbol-resolution under PE/COFF. **Not run on a Windows host;** AVX2 `qjl_quantize_avx2.c` SIMD path on Windows untested.                                |
| 14 | Windows x64 (CUDA)                            | 9b, 27b    | cuda     | `windows-x64-cuda`                        | **TARGET-ONLY**         | Triple in `SUPPORTED_TARGETS`; no Windows-specific CUDA toolchain wiring beyond `LLAMA_CURL=OFF` and the multi-config `--config Release` workaround. No native Windows + CUDA host in lab. Cross from Linux is not implemented (mingw doesn't host nvcc).                       |
| 15 | Windows arm64 (Snapdragon X / Copilot+ PC)    | 1_7b, 9b | cpu / vulkan | **NONE**                              | **NO-TARGET**           | No `windows-arm64-*` triple. Snapdragon X Elite is a real device class in 2026 with Adreno X1 GPU + 12-core ARM CPU. NEON path from `qjl-cpu`/`polarquant-cpu` would apply.                                                                                                     |
| 16 | WebGPU (any browser)                          | 0_6b, 1_7b | webgpu   | **NONE**                                  | **NO-TARGET**           | llama.cpp upstream has a WebGPU backend in progress; no `*-webgpu` triple, no WGSL ports of turbo*/qjl/polar. Out of scope for ship-1 unless mandated.                                                                                                                          |

### Sub-row: per-kernel status on the two verified backends

For completeness — this is the [`README.md`](README.md) matrix re-stated
in this document's status vocabulary:

| Backend | turbo3      | turbo4      | turbo3_tcq  | qjl                          | polar                        |
|---------|-------------|-------------|-------------|------------------------------|------------------------------|
| Metal (M4 Max) | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| Vulkan (Intel ARL + lavapipe) | VERIFIED | VERIFIED | VERIFIED | NOT RUN on that ICD | NOT RUN on that ICD |
| Vulkan (Apple M4 Max via MoltenVK) | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| CUDA / ROCm / Metal-Intel-Mac | TARGET-ONLY | TARGET-ONLY | TARGET-ONLY | TARGET-ONLY | TARGET-ONLY |

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

2. **No `linux-aarch64-*` target = no GH200 / `27b-256k` path.** The
   tier matrix mandates a `27b-256k` tier and the manifest schema
   ([`local-inference/manifest/schema.ts:80`](../app-core/src/services/local-inference/manifest/schema.ts))
   declares its backend matrix as `cuda + vulkan + cpu`, but
   `SUPPORTED_TARGETS` has no aarch64 entry. GH200 is an aarch64 host
   with H100/H200 GPU(s). Currently impossible to publish a `27b-256k`
   bundle that loads on a GH200.
   Owner: build team + kernel team (`sm_90a` CUDA arch flag).
   Effort: M (target plumbing) → L (verification on real GH200).

3. **Vulkan graph dispatch gap.** The standalone Vulkan harness gap is
   resolved: `vulkan_verify` now branches on QJL and Polar fixtures and
   passes all five kernels on Apple M4 Max via MoltenVK. The remaining
   blocker is runtime graph dispatch in the fork: `ggml-vulkan.cpp` still
   needs milady-native descriptors/push constants and per-op routing before
   a `linux-x64-vulkan` or Android build can honestly claim runtime-ready
   QJL/Polar/TurboQuant.
   Owner: kernel team (backend dispatch patch + native-driver smoke).
   Effort: M–L depending on Vulkan backend surface.

4. **No CUDA hardware in the loop.** `linux-x64-cuda` and the
   v0.4.0-milady fork's W4-B CUDA QJL/Polar/TBQ3_TCQ kernels have never
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

5. **iOS Capacitor patch claims the xcframework slot but the milady
   archive never lands there.** ~~RESOLVED IN WIRING (Wave-4-F)~~ — the
   `buildIosLlamaCppSimulatorFramework()` in-process cmake call is gone.
   `ensureIosLlamaCppVendoredFramework()` now invokes
   `build-llama-cpp-dflash.mjs --target ios-arm64-{metal,simulator-metal}`
   and pipes the produced `libllama.a` / `libggml*.a` / public headers
   through `ios-xcframework/build-xcframework.mjs --verify`. The
   patched podspec still points at the same
   `ios/Frameworks-xcframework/LlamaCpp.xcframework` slot, but the slot
   is now filled with the milady-kernel xcframework, not a stock build.
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

3. **Pin `CMAKE_CUDA_ARCHITECTURES` and document the matrix.** Add
   `-DCMAKE_CUDA_ARCHITECTURES="80;86;89;90"` (Ampere, Ada, Hopper) to
   the cuda branch in `cmakeFlagsForTarget` so cross-host CI builds
   produce a fat binary that actually runs on H100/H200/RTX 4090. Today
   the build relies on llama.cpp's default = host probe; on a build host
   without a GPU that means `sm_52` only.
   Owner: build team.

4. **Add `windows-arm64-cpu` and `windows-arm64-vulkan` to
   `SUPPORTED_TARGETS`.** No new toolchain code needed beyond a triple
   parse + cmake flag for `-A ARM64` (MSVC) or
   `--target=aarch64-w64-mingw32` (LLVM mingw). `qjl-cpu`/`polarquant-cpu`
   already have NEON paths. Snapdragon X Elite shipped 2024 — by 2026 it
   is in the same "Capacitor must support this" bucket as iOS.
   Owner: build team.

5. **Run the `darwin-x64-metal` build on any Intel-Mac** (a single CI
   pass on a 2019 MBP, or a friend with a Mac mini Intel) and just diff
   the `metal_verify` numbers against the M4 Max reference. The
   verification path uses `MTLDevice.newLibraryWithSource`, no Apple
   Silicon assumption beyond the threadgroup-=-32 = SIMD-group identity,
   which holds on every Apple GPU but **not** on AMD/Intel Mac GPUs.
   This is the cheapest way to find out whether `darwin-x64-metal` is
   actually shippable for `9b`.
   Owner: device-lab.

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
  path, kernel launch via the v0.4.0-milady fork's CUDA entry points
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

- `darwin-x64-metal` being entirely untested — easy to forget Intel
  Macs exist. Apple still sells refurb 2019 MBPs and many users in 2026
  are still on them. The Metal Family check
  ([`README.md` line 51](README.md)) implies Apple Family-Apple7+, but
  Intel Mac dGPUs are AMD Radeon Pro / Intel Iris — different family
  numbers, different SIMD-group sizes, different `simd_sum` semantics.
  Cannot assume the M4 Max result transfers.

- `windows-x64-cpu` is fully cross-compileable from Linux but no Windows
  host has actually run the produced exe. The `patchGgmlBaseForWindowsQjl`
  pre-build step at `build-llama-cpp-dflash.mjs:439–485` exists
  precisely because someone tried, hit the PE/COFF unresolved-symbol
  failure, and patched around it — so we know the build link-completes,
  but execution semantics on Windows are still unknown.
