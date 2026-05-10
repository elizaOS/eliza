# Unified llama.cpp fork strategy

> North-star plan for landing every Milady on-device inference technique
> (TurboQuant, QJL, PolarQuant, DFlash, head-quant, KV paging) into ONE
> Milady-controlled llama.cpp fork that ships optimized kernels on every
> platform we target. Successor doc to
> [`on-device-quantization-porting-plan.md`](./on-device-quantization-porting-plan.md);
> the porting plan tracks per-technique deliverables, this doc fixes the
> repo, branch, build matrix, and migration order so the next wave of
> agents stops guessing.

## A. Executive summary

**Milady currently builds against three different llama.cpp trees and a
patch directory.** AOSP cross-compiles `Apothic-AI/llama.cpp-1bit-turboquant
@ b2b5273e8b27` and applies `eliza/packages/app-core/scripts/aosp/llama-cpp-patches/{qjl,polarquant}/*`
on every build. The host-side DFlash server is built from
`spiritbuun/buun-llama-cpp @ master` (min commit `b9d01582b`). Stock desktop
runs `node-llama-cpp@3.18.1`, which embeds yet a third llama.cpp build
without TurboQuant/QJL/PolarQuant. The Metal kernel work in
`local-inference/kernels/metal/` is staged as opt-in patch hooks in
`scripts/build-llama-cpp-dflash.mjs` because no fork actually owns the
.metal sources yet. This is unmaintainable: a feature only ships when
two unrelated forks happen to carry the same patch series.

**The fix is a single Milady-owned fork at `milady-ai/llama.cpp` rebased
on `ggml-org/llama.cpp` master**, with every Milady technique as a named
branch off `milady/main`, and every consumer (AOSP `compile-libllama.mjs`,
host `build-llama-cpp-dflash.mjs`, the Capacitor xcframework, the patched
node-llama-cpp binding) pointing at the same commit. The vendored
`scripts/aosp/llama-cpp-patches/` directory becomes a transitional shim
during migration and is deleted once `milady/main` carries the same
commits as commits in the fork. New techniques (BitNet, MXFP4, head
quant, KV paging) land directly as PRs against `milady/main`.

**The win:** one fork to rebuild, one CI matrix to run, one place to land
upstream PRs from. Today QJL exists as four `git format-patch` files that
have to apply cleanly against a moving Apothic base; tomorrow QJL is
`milady/main..milady/qjl-cpu-kernel` and CI rebuilds every backend on
push. Hardware-validated kernels become always-on instead of opt-in env
flags.

## B. Canonical fork — repo, base, branching scheme

**Recommendation: hard-fork (option a in the brief).** Vendored patches
(option b) hit a quadratic maintenance cost as soon as you have more
than two patch series with overlapping touch points (already true for
QJL+PolarQuant+TurboQuant in `ggml-common.h`). A hybrid (option c) keeps
the worst part of both: still need a vendor base AND still need to merge
every technique manually.

| Item | Decision |
|---|---|
| Repo | `https://github.com/milady-ai/llama.cpp` (new, Milady-owned) |
| Upstream base | `ggml-org/llama.cpp` master, rebase nightly to a tagged commit |
| Default branch | `milady/main` |
| Pin at fork creation | upstream `b8198` (matches the apothic base — verified compatible with TBQ patches and the b8198 sampler/vocab API the AOSP shim binds against; see `compile-libllama.mjs:36-63`) |
| Per-technique branches | `milady/turboquant-cpu`, `milady/turboquant-cuda`, `milady/turboquant-metal`, `milady/turboquant-vulkan`, `milady/qjl-cpu`, `milady/qjl-metal`, `milady/qjl-cuda`, `milady/polar-cpu`, `milady/polar-metal`, `milady/polar-cuda`, `milady/dflash-server`, `milady/head-quant`, `milady/kv-paging` |
| Integration branch | `milady/integration` — fast-forwarded from per-technique branches, what every Milady consumer pins against |
| CI tag | `milady-vYYYY.MM.DD-<short-sha>` — one tag per green CI matrix, what `compile-libllama.mjs` and `build-llama-cpp-dflash.mjs` consume |

Rationale for new repo (not fork-of-Apothic): Apothic's b8198 base has
TBQ3_0/TBQ4_0 but no QJL or Polar; spiritbuun's master has TurboQuant
CUDA + DFlash but no Polar; neither has the Metal port. The cleanest
merge base is upstream b8198, then cherry-pick TBQ from Apothic and
DFlash + TurboQuant CUDA from spiritbuun as separate branches. We get
clean credit for upstreaming attempts (PR #21089 is still open as of
2026-04-19; future merges of TBQ upstream become a `git rebase` instead
of a patch deletion).

The vendored `scripts/aosp/llama-cpp-patches/{qjl,polarquant}/` directory
stays in-repo until `milady/main` carries equivalent commits, then the
patches are deleted and `apply-patches.mjs` short-circuits.

## C. Build matrix

Same backend matrix as `build-llama-cpp-dflash.mjs:39-55` plus AOSP/iOS,
unified across both build scripts. Output paths fixed at
`$ELIZA_STATE_DIR/local-inference/bin/<target>/` for host and
`apps/app/android/app/src/main/assets/agent/<abi>/` for AOSP.

| Target triple | CMake flags | Toolchain | Runner | Artifact |
|---|---|---|---|---|
| `linux-x64-cpu` | `GGML_NATIVE=ON` | host gcc/clang | GH `ubuntu-24.04` | `llama-server`, `llama-cli`, `llama-speculative-simple` |
| `linux-x64-cuda` | `GGML_CUDA=ON GGML_CUDA_FA=ON GGML_CUDA_FA_ALL_QUANTS=ON` | nvcc | self-hosted (CUDA L4/A10) | + `libggml-cuda.so` |
| `linux-x64-vulkan` | `GGML_VULKAN=ON` + Khronos headers | host clang + glslc | GH `ubuntu-24.04` | + SPIR-V `.spv` |
| `linux-x64-rocm` | `GGML_HIP=ON` | hipcc | self-hosted (gfx1100) | + `libggml-hip.so` |
| `darwin-arm64-metal` | `GGML_METAL=ON GGML_METAL_EMBED_LIBRARY=ON` | xcrun | self-hosted (M-series) | + `default.metallib` |
| `darwin-x64-metal` | as above | xcrun | self-hosted (Intel Mac) | as above |
| `ios-arm64-metal` | `BUILD_SHARED_LIBS=OFF CMAKE_SYSTEM_NAME=iOS CMAKE_OSX_SYSROOT=iphoneos` | xcrun | self-hosted (M-series) | static `lib*.a` + headers + `.metallib` (consumed by `LlamaCpp.xcframework` patch at `packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch`) |
| `ios-arm64-simulator-metal` | `CMAKE_OSX_SYSROOT=iphonesimulator` | xcrun | self-hosted (M-series) | as above |
| `android-arm64-cpu` (musl) | `GGML_NATIVE=OFF -DCMAKE_SYSTEM_PROCESSOR=aarch64` via zig 0.13+ | `zig cc --target=aarch64-linux-musl` | GH `ubuntu-24.04` | `libllama.so`, `libggml*.so`, `libeliza-llama-shim.so`, `llama-server` (musl-linked, see `compile-libllama.mjs:14-30`) |
| `android-x86_64-cpu` (musl) | as above with `aarch64`→`x86_64` | zig | GH `ubuntu-24.04` | as above (cuttlefish smoke) |
| `android-arm64-vulkan` | NDK toolchain + Khronos headers | NDK r26 + glslc | GH `ubuntu-24.04` | NDK-linked `libllama.so` (separate from musl path — Adreno/Mali GPU access via Vulkan ICD) |
| `windows-x64-cpu` | `GGML_NATIVE=ON` | MSVC / mingw | GH `windows-2022` | `llama-server.exe`, `.dll` runtime |
| `windows-x64-cuda` | `GGML_CUDA=ON` | MSVC + nvcc | self-hosted (Windows + RTX) | + `ggml-cuda.dll` |

GH-hosted runners cover everything except CUDA, ROCm, Apple Silicon, and
the Windows CUDA path. Self-hosted runner labels: `cuda-l4`, `rocm-gfx1100`,
`apple-m3-pro`, `windows-rtx`. Apple Silicon also drives the Metal kernel
verification (`local-inference/kernels/verify/metal_verify`).

## D. Per-technique × per-platform table

Owner column maps to existing worktree commits where the kernel already
exists in some form; "Validation" is the command/harness that proves the
kernel landed correctly. Status legend: `✓` shipped on the unified fork,
`☐` ready to land (kernel exists, needs glue), `▲` blocked, `✗` out of scope.

| Technique | Linux CPU | Linux CUDA | Linux Vulkan | macOS Metal | iOS Metal | Android arm64 musl CPU | Android NDK Vulkan | Owner / source | Validation |
|---|---|---|---|---|---|---|---|---|---|
| **TBQ3_0/TBQ4_0** (V-side KV) | ✓ Apothic base | ✓ via spiritbuun cherry-pick | ☐ via `local-inference/kernels/vulkan/turbo*.comp` | ☐ always-on `patchMetalTurbo4` + opt-in `turbo3.metal` | ☐ same | ✓ libggml-base.so symbol verified (porting plan §"Symbols verified") | ☐ NDK build path | W1-A (Apothic), Agent-D (Metal) | `metal_verify .../turbo3.metal kernel_turbo3_dot fixtures/turbo3.json` |
| **TBQ3_TCQ** (trellis-coded) | ☐ ref C only | ▲ Viterbi encoder needs warp-shuffle port | ☐ `vulkan/turbo3_tcq.comp` (decode-only) | ☐ `metal/turbo3_tcq.metal` (decode-only) | ☐ same | ☐ ref C → NEON encoder | ☐ | W1-D | `metal_verify ... turbo3_tcq fixtures/turbo3_tcq.json` |
| **QJL1_256** (K-side KV) | ☐ vendored patch series `qjl/0001..0004` (`block_qjl1_256` + `GGML_OP_ATTN_SCORE_QJL`); CPU AVX2/NEON exists in `packages/native-plugins/qjl-cpu/` | ☐ port from `packages/training/scripts/quantization/qjl/csrc/` | ☐ port to `.comp` | ☐ `metal/qjl.metal` exists (opt-in via `ELIZA_DFLASH_PATCH_METAL_QJL=1`) | ☐ same | ☐ NEON path validated 100/100 host parity, needs arm64 hardware | ☐ | W1-A (CPU), Agent-D (Metal) | `qjl_bench --parity` (host) + `metal_verify ... qjl fixtures/qjl.json` |
| **Q4_POLAR** (weight-side) | ☐ vendored patch series `polarquant/0001..0004` (scalar ref); NEON/AVX2 = next-session work | ☐ port from `polarquant/csrc/` (training-side, codes-only) | ☐ port to `.comp` | ☐ `metal/polar.metal` exists (opt-in via `ELIZA_DFLASH_PATCH_METAL_POLAR=1`) | ☐ same | ☐ scalar landed, NEON/AVX2 next session | ☐ | W1-B, Agent-D | `polar_roundtrip` + `polar_dot` + `metal_verify ... polar fixtures/polar.json` + Wikitext-2 PPL Δ ≤ +0.05 |
| **DFlash spec-decode** | ✓ via `llama-server --spec-type dflash` (spiritbuun) | ✓ same | ✓ same | ✓ same | ✗ no networking sandbox | ✓ cross-compiled `llama-server` shipped per ABI; `aosp-dflash-adapter.ts` wires it. Drafter pair: Bonsai-8B target + Qwen3-0.6B drafter (matched-vocab; see `dflash-drafter-strategy.md`) | n/a | spiritbuun (DFlash); W1-G (drafter pairing) | `aosp-dflash-adapter.ts` health → 5-prompt round-trip with `n_drafted` > 50% |
| **Head quantization** (per-attn-head bit budget; recommended new addition — see §E) | ☐ port from KIVI/KVQuant ref (per-channel K, per-token V, mixed-precision scoring per head) | ☐ same | ☐ same | ☐ same | ☐ same | ☐ same | ☐ same | new branch `milady/head-quant` | Wikitext-2 PPL Δ vs flat-bit baseline; per-head sensitivity profile written to GGUF metadata |
| **KV paging / split-by-layer offload** (recommended new addition — see §E) | ☐ extend slot-save-path + `n_keep` to a per-layer CPU↔disk pager | n/a | n/a | n/a | n/a | ☐ disk-paged KV is the >128k context unlock on phones | n/a | new branch `milady/kv-paging` | 256k context PPL on a 1B model with no OOM and tok/s ≥ baseline + 20% |
| **BitNet b1.58** (recommended add — see §E) | ☐ port `bitnet.cpp` ternary kernels onto our base; ggml type `TL1`/`TL2` | ☐ CUDA via bitnet.cpp's `bitnet_kernels.cu` | ☐ Vulkan TBD | ☐ MSL TBD | ☐ same | ☐ NEON ternary unpack | ☐ | new branch `milady/bitnet` | bitnet-b1.58-2B-4T inference matches HF reference |
| **MXFP4 / NVFP4** (recommended add — see §E) | ✓ already in upstream master (Apr 2026); rebase free | ✓ Blackwell tensor-core path also upstream | ☐ Vulkan TBD | ☐ Apple Silicon FP4 not real (memory savings only) | ☐ same | ✓ memory savings on phones | ☐ | upstream rebase | upstream `llama-bench` |
| Hexagon HVX / NNAPI / EdgeTPU / WebGPU | ✗ explicitly out of scope per current porting plan §"Out of scope (explicit)" | | | | | | | n/a | n/a |

## E. Capabilities not yet bundled but should be — ranked

**Highest value first; each row scoped to "1+ agent in 1 session" unless noted.**

1. **MXFP4 / NVFP4 rebase.** ggml-org/llama.cpp landed both in March-April
   2026 (block size 32, single-level E8M0 scale for MXFP4; block size 16,
   two-level FP8 E4M3 + FP32 scale for NVFP4). Free win on rebase to
   upstream master. ~1 session: re-pin `LLAMA_CPP_COMMIT`, rebuild matrix,
   add MXFP4/NVFP4 to catalog `kvCacheConfigs[]` in
   `scripts/benchmark/configs/`. Verifies on Blackwell tensor cores;
   memory-only savings on Apple Silicon and phones.
2. **Head-aware KV quant.** KIVI's asymmetric scheme — per-channel K,
   per-token V, plus a sensitivity-aware per-head bit budget from KVTuner
   — composes cleanly with QJL on K and TBQ on V (we already have both;
   per-head bit-budget is a tensor-metadata field plus a dispatcher
   change). Adds ~20% extra KV reduction at iso-PPL on long context.
   Effort: ~3-5 sessions for CPU + dispatch; ~5 sessions for Metal/CUDA.
   Source: jy-yuan/KIVI (Apache 2.0) + arXiv:2402.02750.
3. **BitNet b1.58 ternary support.** Microsoft's bitnet.cpp is a llama.cpp
   fork with TL1/TL2 ternary kernels for ARM/x86/CUDA. Pulling those
   kernels onto our base lights up the entire microsoft/bitnet-b1.58-2B-4T
   class of models for on-device. PR #8151 is the upstream attempt; not
   yet merged. Effort: ~1 week — block format is small (2 ternary values
   per byte), kernels are public, the win is unlocking a model class
   that's already trained for phones (~400MB for 2B). Source:
   microsoft/BitNet, arXiv:2502.11880.
4. **KV disk paging.** Existing llama.cpp options (`--no-kv-offload`,
   `--cache-type-k/v`, `slot-save-path`, `n_keep`) only handle GPU↔CPU
   offload and same-process slot save/load. A disk pager — split KV by
   layer, store cold layers on flash with `mmap`, page in on attention
   miss — is the >128k-context-on-phones unlock. vLLM PagedAttention is
   the GPU-side reference; FlexAttention's BlockMask is the kernel-shape
   reference. Effort: ~2 weeks (new ggml backend op + CPU graph change).
   This one is the biggest non-trivial bet on the list.
5. **TBQ3_TCQ encoder.** Decode-only TCQ already exists across CPU/Metal/Vulkan
   shaders. Encoder requires a 512-state Viterbi over 128 timesteps
   (`reference/turbo_kernels.c` has a slow reference). On CUDA/Metal it
   needs warp-shuffle min-reduction. ~5-7 days. Pure quality win — TCQ
   decoder is already shipped, just an asymmetric encode/decode split
   today.
6. **Drafter quality work.** Current AOSP DFlash pair is Bonsai-8B target
   + Qwen3-0.6B drafter (matched vocab). Acceptance rate is the
   throughput multiplier and hasn't been measured on phone hardware. Add
   `n_drafted/n_accepted` to the benchmark harness; tune `--draft-min`,
   `--draft-max`, `--spec-replace`. Likely 1.5-2.5× speedup left on the
   table (dependent on phone — recent benchmarks show speculative decode
   is *slower* than baseline on RTX 3090 + Qwen3.6-35B-A3B but +30-119%
   on Apple/AMD-Strix; phone Adreno is unmeasured).
7. **HQQ.** Calibration-free 4-bit, integrates in Transformers/vLLM
   today, no llama.cpp upstream. Skip until upstream lands or until a
   model we want is HQQ-only.

## F. node-llama-cpp gap — diagnosis and path

**Diagnosis.** `node-llama-cpp@3.18.1` exposes
`LlamaContextOptions.experimentalKvCacheKeyType`/`experimentalKvCacheValueType`
typed as `"currentQuant" | keyof typeof GgmlType | GgmlType`. The
`GgmlType` enum is **stock** — it does not contain `tbq3_0`, `tbq4_0`,
`qjl1_256`, or `q4_polar`. `engine.ts:319-335` already threads
`overrides.cacheTypeK/V` through to this option, but on a stock
node-llama-cpp build the binding throws on those values at
`createContext()`, which is exactly the gap
`active-model.ts:49-52` calls out.

**Two viable paths:**

- **(a) Fork node-llama-cpp** to a `milady-ai/node-llama-cpp` mirror,
  embed our unified fork as the bundled C++ source, and extend
  `GgmlType` + `resolveGgmlTypeOption` to accept our additions. ~1 week.
  This is the durable answer because it keeps the desktop path on the
  same kernels as the AOSP `bun:ffi` path. Maintenance cost: rebase
  against upstream node-llama-cpp on every minor release (they move
  ~monthly).
- **(b) Bypass via bun:ffi.** Drop node-llama-cpp on desktop entirely
  and call our musl-linked `libllama.so` + `libeliza-llama-shim.so` via
  bun:ffi the same way the AOSP path does (already wired in
  `aosp-llama-adapter.ts`, just needs a desktop adapter and the
  shim binding for `experimentalKvCache*`). ~3-5 days. Drops one C++
  dependency and unifies the desktop+mobile codepath but loses the
  battle-tested node-llama-cpp embedding/grammar/sampler stack.

**Recommendation: (a) now, (b) later.** Forking node-llama-cpp lights
up `cacheTypeK=tbq4_0` on every desktop build with no other code
changes. Migrating the desktop path to bun:ffi is a separate cleanup
once the bun:ffi shim has been hardened on phone hardware.

W1-C already extended `LocalInferenceLoadArgs.cacheTypeK/V` through
`resolveLocalInferenceLoadArgs` and `engine.ts`; the binding-level reject
is where it currently breaks. That's a 1-file change in our forked
binding.

## G. CI strategy

Extend `.github/workflows/local-inference-bench.yml` (W1-H landed) into
a 4-job pipeline:

| Job | Runner | Cost | What it does |
|---|---|---|---|
| `fork-build-host` | GH `ubuntu-24.04`, `windows-2022`, `macos-14` matrix | free | Rebuild every host CPU/Vulkan target on every PR to `milady/main`; runs `metal_verify`/`vulkan_verify` against fixtures (no GPU compute, just SPIR-V/AIR compile). |
| `fork-build-cross` | GH `ubuntu-24.04` | free | AOSP arm64+x86_64 musl via zig + Android Vulkan via NDK + iOS via macos-14 matrix. Output uploaded as artifact. |
| `kernel-verify-gpu` | self-hosted: `cuda-l4`, `rocm-gfx1100`, `apple-m3-pro`, `android-pixel-arm64` | $$$ | Run `metal_verify`/`vulkan_verify` and `qjl_bench --parity` on the actual silicon — only this job catches subgroup-size mismatches and ULP drift. Manual dispatch (cost), nightly schedule, or label-gated PR (`needs-gpu-verify` label). |
| `bench-real-agent` | self-hosted: `apple-m3-pro` for darwin, `android-pixel-arm64` via adb forward, `cuttlefish` for x86_64 emulator | $$ | Existing `profile-inference.mjs` against each backend. Records `tok/s`, `n_drafted`, PPL Δ. Posts results to nightly tracking issue (already wired). |

The current `local-inference-matrix.yml` covers some of this for the
existing AOSP path; `local-inference-bench.yml` is the harness side.
This proposal collapses both into a single workflow against
`milady/main`. Self-hosted-runner label conventions follow Anthropic's
internal usage; if no Apple Silicon runner is available, Metal kernels
get hardware-validated only on developer machines (and the
`local-inference/kernels/README.md` matrix row stays "NEEDS HARDWARE"
until that's fixed).

For PR gating: `fork-build-host` + `fork-build-cross` + `kernel-verify-gpu`
on `milady/main`. `bench-real-agent` runs nightly only.

## H. Migration order

Concrete steps from "vendored patches + scattered branches" to the
unified fork. Each step is a single agent session unless noted.

1. **Create `milady-ai/llama.cpp` repo, push upstream b8198 as
   `milady/main`.** Tag `milady-v2026.05.09-base`. (1h.)
2. **Cherry-pick TBQ commits from
   `Apothic-AI/llama.cpp-1bit-turboquant @ b2b5273`** onto branch
   `milady/turboquant-cpu`. Resolve any drift against b8198 (should be
   none — apothic is b8198 + TBQ). Tag green CI.
3. **Cherry-pick TurboQuant CUDA + DFlash commits from
   `spiritbuun/buun-llama-cpp @ master`** onto branches
   `milady/turboquant-cuda` and `milady/dflash-server`. Validate against
   spiritbuun's existing CUDA test harness on a self-hosted runner.
4. **Apply QJL patch series to a new branch `milady/qjl-cpu`**, port
   commits from `eliza/packages/app-core/scripts/aosp/llama-cpp-patches/qjl/0001..0004`
   into proper `git format-patch`-friendly commits. Add the
   `packages/native-plugins/qjl-cpu/` source as the kernel directly under
   `ggml/src/ggml-cpu/qjl/` instead of vendoring a separate CMake target.
5. **Apply Polar patch series to `milady/polar-cpu`**, same shape. Then
   add the `local-inference/kernels/metal/{qjl,polar}.metal` files
   directly to `ggml/src/ggml-metal/` on `milady/qjl-metal` and
   `milady/polar-metal`. Drop the `ELIZA_DFLASH_PATCH_METAL_*` opt-in
   gates once `metal_verify` reports 8/8 PASS — they become always-on.
6. **Fast-forward `milady/integration` from each per-technique branch.**
   Run the full CI matrix from §G. Tag green output as `milady-v2026.05.X`.
7. **Switch `compile-libllama.mjs:165-167` to point at
   `milady-ai/llama.cpp @ milady/integration`.** Delete
   `scripts/aosp/llama-cpp-patches/{qjl,polarquant}/` and the
   `apply-patches.mjs` invocation. The directory and script can be
   removed (they're transitional shims); leave them gitignored for one
   release in case of rollback.
8. **Switch `build-llama-cpp-dflash.mjs:33-37` to point at the same
   ref.** Delete `patchMetalTurbo4`, `patchMetalQjl`, `patchMetalPolar`,
   `patchMetalTurbo3Tcq`, `patchVulkanKernels` — all five become no-ops
   because the fork carries the kernels directly. Keep the function
   signatures during the transition, just have them log "patch already
   on fork" and return.
9. **Fork `node-llama-cpp` to `milady-ai/node-llama-cpp`**, embed our
   unified fork as the bundled C++ source, extend `GgmlType` /
   `resolveGgmlTypeOption` to accept `tbq3_0`, `tbq4_0`, `qjl1_256`,
   `q4_polar`. Pin desktop builds at the milady-binding version. (~1
   week — see §F.)
10. **Land MXFP4/NVFP4** by upstream rebase (free). Then queue
    head-quant, KV paging, and BitNet as ranked in §E. Each lands as a
    new `milady/<technique>` branch + PR to `milady/integration`.
11. **Open upstream PRs.** Each branch off `milady/main` should be a
    candidate PR back to `ggml-org/llama.cpp` (TBQ already has
    PR #21089 — aim to keep our diff small enough to be merge-able).
    Once a technique merges upstream, delete our branch and rebase.

**Rollback plan.** Every step keeps the pre-migration code path alive
until the new path is green. The unified fork is opt-in via
`MILADY_LLAMA_CPP_REMOTE` env until step 7, at which point the default
flips. The patch directory stays in git history, so reverting is one
script edit.

## Pinned references

- `ggml-org/llama.cpp` PR #21089 (TurboQuant CPU TBQ3_0/TBQ4_0 — open as
  of 2026-04-19).
- `ggml-org/llama.cpp` Issue #20977 (TurboQuant feature-request thread,
  277+ thumbs).
- `Apothic-AI/llama.cpp-1bit-turboquant @ main-b8198-b2b5273` (current
  AOSP base).
- `spiritbuun/buun-llama-cpp @ master` (current DFlash + CUDA base; min
  commit `b9d01582b`).
- `microsoft/BitNet` (TL1/TL2 ternary kernels).
- `jy-yuan/KIVI` (asymmetric per-channel K + per-token V; ICML 2024,
  arXiv:2402.02750, Apache 2.0).
- `SqueezeAILab/KVQuant` (NeurIPS 2024, arXiv:2401.18079, mixed-precision
  per-channel K + dense/sparse outliers).
- vLLM `Quantized KV Cache` docs (PagedAttention reference for the KV
  paging branch).
- `withcatai/node-llama-cpp` v3.18.1 release notes (`experimentalKvCache*`
  options surface, stock `GgmlType` enum).
- `local-inference/kernels/README.md` (current Metal/Vulkan port status,
  `metal_verify`/`vulkan_verify` harness, fixture protocol).
- `docs/porting/dflash-drafter-strategy.md` (matched-vocab drafter
  decision; SmolLM2-360M → Qwen3-0.6B).
- `docs/porting/on-device-quantization-porting-plan.md` (per-technique
  status, AOSP bundle verification commands).
- `docs/porting/benchmark-harness.md` (the harness `bench-real-agent`
  drives).

## Out of scope for this strategy doc

- **Hexagon HVX / Snapdragon QDSP6 ports.** Excluded per current porting
  plan; revisit only after NEON paths are validated on Pixel hardware
  AND a meaningful number of users are on a Hexagon-routable device.
- **NNAPI / EdgeTPU / Pixel Tensor TPU.** KV-cache compressors don't fit
  the static-graph delegate model; this would mean abandoning llama.cpp
  for MediaPipe LLM Inference, which is a separate product decision.
- **WebGPU.** ggml-webgpu backend is not stable enough as of May 2026;
  revisit when upstream lands TBQ.
- **Training-time-only paths** (PolarQuant calibration, TurboQuant
  calibration, QJL projection generation). Stay in
  `packages/training/`.
- **AWQ / GPTQ / IQ-quants subtypes (IQ3_XXS..IQ4_XS) / Q2_K..Q6_K.**
  All already in upstream llama.cpp; rebasing onto `milady/main` picks
  them up for free.
