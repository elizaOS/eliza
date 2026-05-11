# Eliza-1 device support gap analysis — 2026-05-10

> Superseded status note, 2026-05-11: keep this file as historical context.
> The current blocker ledger is
> `packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`.
> Since this audit, Vulkan standalone QJL/Polar verification was added on
> Apple M4 Max via MoltenVK, Metal `GGML_OP_ATTN_SCORE_QJL` graph dispatch
> became runtime-ready, and the build gate was tightened so `turbo3_tcq` is
> required alongside `turbo3`, `turbo4`, QJL, Polar, and DFlash.

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
| 1 | Apple Silicon Mac, M4 Max                     | desktop-9b, pro-27b    | metal    | `darwin-arm64-metal`                      | **VERIFIED**            | [`README.md` lines 7–10, 308–312](README.md); [`bench_M4Max_2026-05-10.md`](bench_M4Max_2026-05-10.md). 5/5 shaders 8/8 PASS via `MTLDevice.newLibraryWithSource` (Wave-3, Darwin 25.2.0).                                                                                     |
| 2 | Apple Silicon Mac, M1 / M2 / M3               | desktop-9b, pro-27b    | metal    | `darwin-arm64-metal`                      | **VERIFIED-ADJACENT**   | Same Apple GPU family, Metal 3 / Family-Apple7+, same 32-thread SIMD-group assumption ([`README.md` line 51, 209–212](README.md)). Untested on M1/M2/M3; should retest before flipping `defaultEligible: true` on the desktop manifest for these chips.                        |
| 3 | Intel/AMD Mac (x64 + AMD/Intel GPU)           | desktop-9b             | metal    | `darwin-x64-metal`                        | **TARGET-ONLY**         | Triple parses ([`build-llama-cpp-dflash.mjs:90`](../app-core/scripts/build-llama-cpp-dflash.mjs)) and `cmakeFlagsForTarget` honors it, but no Intel-Mac hardware in lab. AMD Radeon Pro / Intel Iris Metal driver behavior on `simd_sum` over 32-lane TG is **not** verified.  |
| 4 | iOS arm64 (iPhone 14+)                        | lite-0_6b, mobile-1_7b | metal    | `ios-arm64-metal`                         | **PARTIALLY-RESOLVED** (Wave-4-F) | `run-mobile-build.mjs ensureIosLlamaCppVendoredFramework()` now delegates to `build-llama-cpp-dflash.mjs --target ios-arm64-metal`, then `packages/app-core/scripts/ios-xcframework/build-xcframework.mjs --verify` glues the produced static archives into `node_modules/llama-cpp-capacitor/ios/Frameworks-xcframework/LlamaCpp.xcframework`. The npm-bundled stock `LlamaCpp.framework` is archived out of `FRAMEWORK_SEARCH_PATHS`. **Build verified end-to-end on this M4 Max host (Xcode 26.4 / iPhoneOS26.4.sdk):** QJL + PolarQuant + DFlash symbols present in both slices (`nm -g` PASS for `_ggml_attn_score_qjl`, `_ggml_fused_attn_qjl_tbq`, `_quantize_q4_polar`, `_dequantize_row_qjl1_256`, `_llama_decode`). **TurboQuant variants (turbo3/turbo4/turbo3_tcq) still missing** — `kernel-patches/metal-kernels.mjs` does not yet handle the `GGML_METAL_EMBED_LIBRARY=ON` branch iOS uses. `build-xcframework.mjs --verify` correctly hard-fails on this gap (no silent fallback). Real-iPhone runtime verification still pending an XCTest harness. |
| 5 | iOS arm64 simulator (Apple Silicon Mac)       | lite-0_6b, mobile-1_7b | metal    | `ios-arm64-simulator-metal`               | **PARTIALLY-RESOLVED** (Wave-4-F) | Same wiring as row 4. Simulator slice is the second `--framework` argument to `xcodebuild -create-xcframework`, packaged with its own static `LlamaCpp.framework` containing matching kernel symbols. Verified via `lsbom`-equivalent inspection of the produced `Info.plist` (`AvailableLibraries` lists both `ios-arm64` and `ios-arm64-simulator` slices). Same TurboQuant EMBED-path gap as row 4 blocks full-kernel coverage. |
| 6 | Android arm64 (Adreno 6xx+ / Mali-G7x+)       | lite-0_6b, mobile-1_7b | vulkan   | `android-arm64-vulkan`                    | **TARGET-ONLY**         | Build target exists, NDK toolchain wired ([`build-llama-cpp-dflash.mjs:670–689`](../app-core/scripts/build-llama-cpp-dflash.mjs)). Vulkan turbo* shaders verified on Mesa lavapipe + Intel ARL only. **No on-device Adreno/Mali run.** Android API floor `android-28` (line 680). |
| 7 | Android arm64 (CPU fallback)                  | lite-0_6b              | cpu      | `android-arm64-cpu`                       | **TARGET-ONLY**         | Build target exists; runtime CPU NEON paths from `qjl-cpu` / `polarquant-cpu` referenced in `patchGgmlBaseForWindowsQjl`. No on-device Snapdragon/Tensor run logged.                                                                                                            |
| 8 | Linux x64 + NVIDIA (RTX/A100)                 | desktop-9b, pro-27b    | cuda     | `linux-x64-cuda`                          | **TARGET-ONLY**         | Triple compiles; `-DGGML_CUDA_FA=ON -DGGML_CUDA_FA_ALL_QUANTS=ON` set ([`build-llama-cpp-dflash.mjs:638`](../app-core/scripts/build-llama-cpp-dflash.mjs)). No `CMAKE_CUDA_ARCHITECTURES` pin (relies on llama.cpp default = host probe / native). No CUDA host in lab; W4-B CUDA QJL/Polar/TBQ3_TCQ kernels in v0.4.0-milady fork are unverified end-to-end.        |
| 9 | Linux x64 + AMD (MI300 / MI250 / RX 7000)     | desktop-9b, pro-27b    | rocm     | `linux-x64-rocm`                          | **TARGET-ONLY**         | Triple compiles when `hipcc`/`rocminfo` present. `-DGGML_HIP=ON` only — no AMD GPU arch pin (`GFX942`, `GFX1100`, etc.). No ROCm host in lab; QJL/Polar HIP path inherits from CUDA via hipify and is unverified.                                                              |
| 10 | Linux x64 + Intel/AMD/NVIDIA (Vulkan)         | mobile-1_7b → pro-27b  | vulkan   | `linux-x64-vulkan`                        | **PARTIAL VERIFIED**    | turbo3 / turbo4 / turbo3_tcq: VERIFIED on Intel ARL Mesa 25.2.8 + lavapipe ([`README.md` line 7, 303–305](README.md)). qjl / polar: NEEDS HARNESS EXTENSION ([`README.md` lines 306–307, 341–348](README.md)) — `verify/vulkan_verify.cpp:268–315` hard-codes the 3-buffer turbo bind-set. |
| 11 | Linux x64 (CPU)                               | all                    | cpu      | `linux-x64-cpu`                           | **VERIFIED (reference)** | `verify/gen_fixture --self-test` passes on host with QJL/Polar reference parity checks ([`README.md` lines 322–334](README.md)). This verifies the C reference, not a particular x86 SIMD path. AVX2/NEON dispatch in `qjl-cpu`/`polarquant-cpu` not separately benched here.   |
| 12 | Linux aarch64 (GH200, Ampere Altra, Graviton) | server-h200            | cpu / cuda | **NONE**                                | **NO-TARGET**           | `SUPPORTED_TARGETS` ([`build-llama-cpp-dflash.mjs:82–109`](../app-core/scripts/build-llama-cpp-dflash.mjs)) has no `linux-aarch64-*` entry. GH200 has aarch64 CPU + H100/H200 GPU; the H100/H200 GPU half *might* work via `linux-x64-cuda` if you put a discrete x64 launcher in front of it, but the canonical GH200 deployment is single-binary aarch64 host + sm_90a CUDA. **Hard miss for the `server-h200` tier.**                                              |
| 13 | Windows x64 (CPU)                             | desktop-9b, pro-27b    | cpu      | `windows-x64-cpu`                         | **COMPILE-ONLY**        | Cross-compile via x86_64-w64-mingw32 wired ([`build-llama-cpp-dflash.mjs:285–417, 690–734`](../app-core/scripts/build-llama-cpp-dflash.mjs)) with `patchGgmlBaseForWindowsQjl` to fix QJL symbol-resolution under PE/COFF. **Not run on a Windows host;** AVX2 `qjl_quantize_avx2.c` SIMD path on Windows untested.                                |
| 14 | Windows x64 (CUDA)                            | desktop-9b, pro-27b    | cuda     | `windows-x64-cuda`                        | **TARGET-ONLY**         | Triple in `SUPPORTED_TARGETS`; no Windows-specific CUDA toolchain wiring beyond `LLAMA_CURL=OFF` and the multi-config `--config Release` workaround. No native Windows + CUDA host in lab. Cross from Linux is not implemented (mingw doesn't host nvcc).                       |
| 15 | Windows arm64 (Snapdragon X / Copilot+ PC)    | mobile-1_7b, desktop-9b | cpu / vulkan | **NONE**                              | **NO-TARGET**           | No `windows-arm64-*` triple. Snapdragon X Elite is a real device class in 2026 with Adreno X1 GPU + 12-core ARM CPU. NEON path from `qjl-cpu`/`polarquant-cpu` would apply.                                                                                                     |
| 16 | WebGPU (any browser)                          | lite-0_6b, mobile-1_7b | webgpu   | **NONE**                                  | **NO-TARGET**           | llama.cpp upstream has a WebGPU backend in progress; no `*-webgpu` triple, no WGSL ports of turbo*/qjl/polar. Out of scope for ship-1 unless mandated.                                                                                                                          |

### Sub-row: per-kernel status on the two verified backends

For completeness — this is the [`README.md`](README.md) matrix re-stated
in this document's status vocabulary:

| Backend | turbo3      | turbo4      | turbo3_tcq  | qjl                          | polar                        |
|---------|-------------|-------------|-------------|------------------------------|------------------------------|
| Metal (M4 Max) | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| Vulkan (Intel ARL + lavapipe) | VERIFIED | VERIFIED | VERIFIED | BLOCKED (harness) | BLOCKED (harness) |
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
   QJL + PolarQuant + DFlash symbols are confirmed present in both
   xcframework slices on this M4 Max host. **Residual:** the TurboQuant
   metallib EMBED-path patcher (`kernel-patches/metal-kernels.mjs`) still
   needs to learn the `GGML_METAL_EMBED_LIBRARY=ON` branch — currently
   `--verify` hard-fails on `turbo3` / `turbo4`. Once that lands the iOS
   row flips fully RESOLVED.
   Owner: kernel team (EMBED-path patch) → device-lab (real-iPhone XCTest harness).
   Effort: S (EMBED-path patch) + S (XCTest harness).

2. **No `linux-aarch64-*` target = no GH200 / `server-h200` path.** The
   tier matrix mandates a `server-h200` tier and the manifest schema
   ([`local-inference/manifest/schema.ts:80`](../app-core/src/services/local-inference/manifest/schema.ts))
   declares its backend matrix as `cuda + vulkan + cpu`, but
   `SUPPORTED_TARGETS` has no aarch64 entry. GH200 is an aarch64 host
   with H100/H200 GPU(s). Currently impossible to publish a `server-h200`
   bundle that loads on a GH200.
   Owner: build team + kernel team (`sm_90a` CUDA arch flag).
   Effort: M (target plumbing) → L (verification on real GH200).

3. **Vulkan QJL/Polar harness gap.** `verify/vulkan_verify.cpp:268–315`
   only knows the 3-buffer turbo bind-set (`q`, `k`, `scores` ± codebook
   for tcq). QJL needs `q_sketch + packed_k(34B blocks) + scores` plus
   a 4-uint push-constant struct (`n_heads, n_kv_heads, n_tokens,
   proj_dim`); Polar needs `k_blocks(82B blocks) + q + y` plus
   `n_rows, head_dim, use_qjl`. Without harness extension, no Vulkan
   device — Adreno, Mali, Intel Arc/discrete, NVIDIA Vulkan, AMD RDNA —
   can be claimed verified for QJL or PolarQuant. This blocks every
   non-Metal mobile and every non-CUDA desktop tier from passing the
   manifest's `kernels.required` gate.
   Owner: kernel team (harness extension + fixture regen from
   `qjl_polar_ref.c`).
   Effort: S–M (~1-2 days of harness work; same shape as the existing
   turbo path; see `verify/ROADMAP.md`).

4. **No CUDA hardware in the loop.** `linux-x64-cuda` and the
   v0.4.0-milady fork's W4-B CUDA QJL/Polar/TBQ3_TCQ kernels have never
   been observed running on a real NVIDIA card in this repo. The build
   target compiles when `nvcc` is present
   ([`build-llama-cpp-dflash.mjs:812`](../app-core/scripts/build-llama-cpp-dflash.mjs))
   but `metal_verify`/`vulkan_verify` style numerical parity checks have
   no CUDA equivalent in `verify/`. AGENTS.md §8 requires *"the CUDA
   path (where applicable) reproduces the same outputs to the same
   numerical tolerance"*. Today this is a paper claim. Blocks
   `desktop-9b`, `pro-27b`, `server-h200`.
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
   Pairs with blocker #1's residual TurboQuant gap.
   Owner: kernel team (EMBED-path patcher to fully close).
   Effort: S.

---

## 3. Top 5 quick wins (S-effort, high impact)

1. **Extend `vulkan_verify.cpp` to QJL bind-set.** Branch on
   `fx.kernel == "qjl"` for a 3-buffer (`q_sketch`, `packed_k(34B)`,
   `scores`) + 16-byte push-constant layout. Regenerate `qjl.json`
   fixture from `verify/qjl_polar_ref.c`. Unblocks every Vulkan device
   for the QJL kernel. ~3-4h of harness work.
   Owner: kernel team.

2. **Extend `vulkan_verify.cpp` to Polar bind-set.** Same shape as #1
   for the 3-buffer (`k_blocks(82B)`, `q`, `y`) + 12-byte push-constant
   layout. Same fixture regen. Unblocks PolarQuant on every Vulkan
   device.
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
   actually shippable for `desktop-9b`.
   Owner: device-lab.

---

## 4. `verify/` harness extension roadmap (one-liner per missing extension)

See [`verify/ROADMAP.md`](verify/ROADMAP.md) for the full plan. One-line
summary per extension below; the doc has the full bind-set, fixture
shape, and host-pairing detail.

- **vulkan_verify QJL bind-set** — branch on `fx.kernel`, allocate
  `q_sketch[n_heads*256]` + `packed_k[n_kv_heads*n_tokens*34]` +
  `scores[n_heads*n_tokens]`, push 4 uints. Regenerate `qjl.json` from
  `qjl_polar_ref.c qjl_score_qk_ref` with deterministic seed.

- **vulkan_verify Polar bind-set** — branch, allocate
  `k_blocks[n_rows*82]` + `q[head_dim]` + `y[n_rows]`, push 3 uints.
  Regenerate `polar.json` from `qjl_polar_ref.c polar_dot_ref`. Cover
  both `use_qjl=0` and `use_qjl=1` cases (two fixture variants).

- **`cuda_verify` (new harness)** — same JSON fixture format,
  `cudaMalloc` + `cudaMemcpy` instead of vulkan_verify's host-visible
  path, kernel launch via the v0.4.0-milady fork's CUDA entry points
  (`turbo_quant_cuda.cuh`, the W4-B QJL/Polar/TBQ3_TCQ additions). One
  binary, branch on `fx.kernel`. CI-runnable on any L4/T4 EC2 instance.

- **Adreno on-device runner** — cross-compile `vulkan_verify` against
  the NDK Vulkan headers (already wired in `cmakeFlagsForTarget`),
  `adb push` the SPIR-V + fixtures + binary, run on a Pixel-class device
  (Adreno 730+) or Galaxy S24 (Adreno 750). Same fixtures, no new code.

- **Mali on-device runner** — same as Adreno but on a Pixel-Tensor /
  Galaxy non-Snapdragon device (Mali-G715+). Mali subgroup behavior
  differs from Adreno on `subgroupAdd`; the W4-A shared-mem tree
  reduction sidesteps that, but it still needs a real run to confirm.

- **iOS device runner** — once blocker #1 is fixed and the milady
  xcframework is actually consumed, `metal_verify` won't run on
  on-device iOS (no shell). Need either a tiny iOS app target that
  embeds the harness as XCTest, or a test-target build that runs
  `metal_verify` logic via XCUITest. Same shaders, same fixtures.

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
