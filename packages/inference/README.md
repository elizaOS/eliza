# TurboQuant / QJL / PolarQuant KV cache kernels (Vulkan + Metal)

> **STATUS — All five Metal shaders hardware-verified 8/8 PASS on Apple M4 Max (Wave-3, 2026-05-10; perf pass 2026-05-10 dropped polar GPU median from 5726 µs → 458 µs via threadgroup-cooperative Hadamard butterfly, see `SHADER_REVIEW_2026-05-10.md`). Vulkan turbo* hardware-verified on Intel ARL + lavapipe (8/8 PASS each). Vulkan QJL + Polar now hardware-verified 8/8 PASS on Apple M4 Max via MoltenVK 1.4.1 (Wave-4-C harness extension; polar.comp ports the W4-B threadgroup-cooperative Hadamard, qjl.comp ports the vec4+branchless+FMA pattern; max diff 7.6e-6 / 5.7e-6).**
>
> | Family       | Files                                                            | Source-level checked against fork? | Compiles with target SDK? | Validated on hardware? |
> | ------------ | ---------------------------------------------------------------- | ---------------------------------- | ------------------------- | ---------------------- |
> | TurboQuant — Vulkan | `vulkan/turbo3.comp`, `vulkan/turbo4.comp`, `vulkan/turbo3_tcq.comp` | YES (byte layout + decode math match in-tree `dequantize_turbo3_*` and the in-tree `tbq4_0.metal` `block_turbo4_0` layout) | YES (Mesa NDK glslc, SPIR-V 1.3 / Vulkan 1.1) | YES — 8/8 PASS on Intel ARL Mesa 25.2.8 + lavapipe Mesa 25.2.8 LLVMpipe |
> | TurboQuant — Metal  | `metal/turbo3.metal`, `metal/turbo4.metal`, `metal/turbo3_tcq.metal` | YES (matches in-tree `dequantize_turbo3_0_t4` + the in-tree `tbq4_0.metal` `block_turbo4_0` layout) | YES (`clang++ -framework Metal` runtime JIT path; Metal Toolchain not required for `metal_verify`) | YES — 8/8 PASS on Apple M4 Max (Darwin 25.2.0, runtime `MTLDevice.newLibraryWithSource`); max diff 6.7e-06 |
> | QJL          | `metal/qjl.metal`, `vulkan/qjl{,_get_rows,_mul_mv}.comp`         | YES (against `qjl_score_qk_ref` in `packages/native-plugins/qjl-cpu`) | YES (Vulkan); YES (Metal — runtime JIT) | Metal: YES — 8/8 PASS on Apple M4 Max after Wave-3 fix to `kernel_attn_score_qjl1_256` (uniform `uint3` attribute params; original mixed `uint`+`uint2` failed Metal compile). Vulkan: YES — 8/8 PASS on Apple M4 Max via MoltenVK 1.4.1 (Wave-4-C); max diff 7.629e-6 |
> | PolarQuant   | `metal/polar.metal`, `vulkan/polar{,_get_rows}.comp`             | YES (against `dequantize_row_q4_polar_ref` + `polar_dot_ref` in `packages/native-plugins/polarquant-cpu`) | YES (Vulkan); YES (Metal — runtime JIT) | Metal: YES — 8/8 PASS on Apple M4 Max. Vulkan: YES — 8/8 PASS on Apple M4 Max via MoltenVK 1.4.1 (Wave-4-C, after threadgroup-cooperative Hadamard mirror); max diff 5.722e-6 |
> | CUDA (all 5) | `verify/cuda_verify.cu` linking `~/.cache/eliza-dflash/milady-llama-cpp/build-cuda/.../libggml-cuda.so` (qjl, polar, turbo3_tcq exported symbols; turbo3/turbo4 via thin `__global__` wrapper around the shipped device-side `tbq_decode_block_cuda`) | YES (against `ggml-cuda/{turboquant,turbo-tcq,qjl,polarquant}.cu(h)` in fork v0.4.0-milady; `make cuda-preprocess-check` asserts every API symbol + every `block_*` layout is present in the in-fork headers) | NEEDS-HARDWARE — `make cuda` requires `nvcc` (gated on Linux + CUDA Toolkit; macOS not supported); preprocessor-only API surface check passes on M4 Max | NEEDS-HARDWARE — see `verify/CUDA_VERIFICATION.md` for the end-to-end runbook (local CUDA host or `CUDA_REMOTE=user@host ./cuda_runner.sh`) |
>
> Earlier history: the original `turbo*.comp` Vulkan port reported 0/8 PASS
> against Mesa llvmpipe AND Intel ARL — different wrong values per ICD,
> which fingerprinted a source-level subgroup-size assumption (`subgroupAdd`
> over a 32-thread workgroup with no `requiredSubgroupSize`). Wave-4 W4-A
> replaced that with the same driver-portable shared-memory tree reduction
> the new W3-E QJL/Polar shaders use; the result is 8/8 PASS on both ICDs.
> See `reports/porting/2026-05-09-w4/vulkan-turbo-fix.md`.
>
> The Metal ports here mirror the **same** decode math as the fork's
> existing, shipping `dequantize_turbo3_0_t4` and the fork's in-tree
> `tbq4_0.metal` (`block_turbo4_0` = `half norm; uint8_t qs[64]`) — so the
> byte layout and centroid lookup have been triple-checked at the source
> level. None of that is a substitute for `metal_verify` reporting 8/8
> PASS on a real Apple GPU.
>
> Patch-hook status (post 2026-05-10 audit):
>
>   * The five Metal patch hooks have been collapsed into one
>     `patchMetalKernels` implementation in
>     `packages/app-core/scripts/kernel-patches/metal-kernels.mjs`. It
>     copies the verified standalones from `packages/inference/metal/` into
>     the fork at `ggml/src/ggml-metal/milady-shipped/<name>.metal`, then
>     patches `ggml/src/ggml-metal/CMakeLists.txt` so each standalone is
>     compiled into its own `.air` and merged into `default.metallib`
>     alongside `ggml-metal.air`. The patch fires unconditionally on every
>     Metal target — no env-var opt-in. The previous opt-in environment
>     variables (`ELIZA_DFLASH_PATCH_METAL_*=1`) were decorative log toggles
>     and are removed. Idempotent via `# MILADY-KERNEL-PATCH-V1` sentinel.
>
>   * For Apple desktop targets the script now sets
>     `-DGGML_METAL_EMBED_LIBRARY=OFF`, so the patched `add_custom_command`
>     (which lives in the non-EMBED branch of the fork's CMakeLists.txt)
>     actually runs. iOS targets keep `EMBED_LIBRARY=ON` because the
>     static-archive build needs the metallib data baked in via `.incbin`,
>     but the EMBED path is NOT yet wired — the iOS metallib will not
>     contain the milady kernels until a separate dup-strip patcher lands
>     in `metal-kernels.mjs`. `requiredKernelsMissing()` will refuse the
>     iOS artifact accordingly.
>
>   * The Vulkan `patchVulkanKernels` hook now copies the eight standalone
>     `.comp` files from `packages/inference/vulkan/` into the fork at
>     `ggml/src/ggml-vulkan/milady-shipped/<name>.comp`. It also
>     hard-throws when a `*-vulkan` target is queued because the fork at
>     v0.4.0-milady has neither registration in `vulkan-shaders-gen` nor
>     dispatch sites in `ggml-vulkan.cpp` for the milady quant types.
>     `ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN=1` exists as an audit-loggable
>     escape hatch.
>
>   * Deferred dispatch wiring (Wave-6 audit, 2026-05-10): `ggml-metal-ops.cpp`
>     and `ggml-metal-device.m` do NOT yet contain dispatch sites for
>     `GGML_TYPE_TBQ3_0`, `GGML_TYPE_TBQ4_0`, `GGML_TYPE_TBQ3_TCQ`,
>     `GGML_TYPE_QJL1_256`, `GGML_TYPE_Q4_POLAR`. After Wave-5 the kernel
>     SYMBOLS are present in the metallib (`strings default.metallib | grep
>     kernel_turbo3_dot` hits), but the runtime cannot select them via the
>     type-traits table.
>
>     **Wave-6 finding — kernel ABI is incompatible with the standard
>     ggml-metal mul_mv dispatch contract.** The fork's
>     `ggml_metal_library_get_pipeline_mul_mv` constructs a pipeline name
>     `kernel_mul_mv_<typename_src0>_<typename_src1>_nsg=N`, sets a function
>     constant `nsg` (subgroup count) at index `FC_MUL_MV+0`, binds buffers
>     in the layout `ggml_metal_kargs_mul_mv` from `ggml-metal-impl.h`, and
>     dispatches with `nsg`-many simdgroups per row. The verified standalone
>     `kernel_mul_mv_qjl1_256_f32` and `kernel_mul_mv_q4_polar_f32`
>     entrypoints take a custom argument struct (`qjl_score_args`,
>     `polar_dequant_args`), do NOT declare an `nsg` function constant, and
>     dispatch one threadgroup per row (fixed `threadgroup_size=32`).
>     Calling them via the standard pipeline path crashes the Metal
>     compiler at constant-binding time.
>
>     Symbol-only state (Metal): `kernel_turbo3_dot`, `kernel_turbo4_dot`,
>     `kernel_turbo3_tcq_dot`, `kernel_attn_score_qjl1_256`,
>     `kernel_get_rows_qjl1_256`, `kernel_mul_mv_qjl1_256_f32`,
>     `kernel_get_rows_q4_polar`, `kernel_mul_mv_q4_polar_f32` all linked
>     into `default.metallib`; verified by `strings`. Reachability via
>     `MTLDevice.newLibraryWithSource` JIT (the `metal_verify` harness)
>     confirmed 8/8 PASS. Reachability from `ggml_compute_*` graph
>     evaluation is NOT confirmed and requires either:
>
>       (a) editing the standalones to take `ggml_metal_kargs_*` and
>           `nsg` function constants — forbidden by the standalone
>           freeze contract, or
>       (b) shipping bridge wrapper kernels in `ggml-metal.metal` that
>           accept the standard kargs ABI and trampoline into the
>           standalone entrypoints with a translated argument struct —
>           pending design, or
>       (c) carving a parallel dispatch path
>           (`ggml_metal_op_mul_mv_milady_quant`) in `ggml-metal-ops.cpp`
>           that bypasses `get_pipeline_mul_mv` and binds the standalones'
>           custom argument structs directly — pending design.
>
>     CUDA is the only backend whose v0.4.0-milady binary fully satisfies
>     AGENTS.md §3 today (the CUDA fork has explicit dispatch entries in
>     `ggml-cuda/ggml-cuda.cu` for these types). Metal kernels are
>     production-shipped as JIT-loadable artifacts in `default.metallib`
>     but the graph executor cannot route ops to them without one of (b)
>     or (c). `requiredKernelsMissing()` reports them as missing for any
>     Metal target that uses help-string detection.
>
>   * Wave-6 darwin shared-lib link fix: ggml-base on darwin defaults to
>     `BUILD_SHARED_LIBS=ON` and links with `-undefined error`, so
>     unresolved `quantize_qjl1_256` / `dequantize_row_qjl1_256` /
>     `quantize_row_qjl1_256_ref` symbols (called from `ggml.c` but
>     defined in `ggml-cpu/qjl/`) made `libggml-base.dylib` fail to link
>     at all. The Wave-5 BLOCKER agent's "verified via strings" claim
>     was against a stale metallib produced by an earlier shape; the
>     end-to-end build never actually completed. Wave-6 extends
>     `patchGgmlBaseForWindowsQjl` to fire on `darwin-*` and `ios-*`
>     targets (same fix as Windows: compile QJL TUs into ggml-base too).
>
> The most likely on-hardware failure modes (carry-overs from the Vulkan
> investigation, applicable here too):
>
>   1. **FWHT seed/sign-vector application.** All five shaders assume Q is
>      pre-rotated host-side (matches the fork's CUDA + Metal paths). If you
>      wire them into a pipeline that does NOT pre-rotate Q, you must add
>      an inverse FWHT to the dequantized output before the dot product.
>   2. **SIMD-group reduction.** The Metal shaders all dispatch with
>      threadgroup_size = 32 = one Apple SIMD-group, so `simd_sum` covers
>      the full reduction. If anyone bumps the threadgroup size, switch to
>      threadgroup-shared scratch + barrier.
>   3. **Block byte layout.** `block_turbo*`, `block_qjl1_256`, and
>      `block_q4_polar` are all `__attribute__((packed))` in the C reference
>      and have natural alignment 2 (fp16/bf16 leading field). Metal
>      `device const T*` arithmetic must respect this — if you change the
>      header layout, the shader's `head_offset_bytes` arg goes stale.
>
> The harness IS reusable for fixing the above — `metal_verify` loads
> a `.metal` source, JIT-compiles via `MTLDevice.newLibraryWithSource`,
> dispatches the named kernel, and diffs against a JSON fixture.

## Source of truth

### TurboQuant
CUDA originals: `https://github.com/spiritbuun/buun-llama-cpp.git` at commit
`6575873e9c4872709d374d854b583cfaa270caff`, paths:

- `ggml/src/ggml-cuda/turbo-quant-cuda.cuh` — quantize/dequantize, codebooks, FWHT, Viterbi
- `ggml/src/ggml-cuda/fattn-vec.cuh` — flash-attention vec path that consumes them
- `ggml/src/ggml-common.h` — `block_turbo3_0`, `block_turbo4_0`, `block_turbo3_tcq` layouts
- `ggml/src/ggml-cpu/ops.cpp` and `ggml/src/ggml-turbo-quant.c` — CPU reference (lossy stubs)
- `ggml/src/ggml-metal/ggml-metal.metal` and `turbo-wht.h` — existing Metal shader ground truth (the `dequantize_turbo3_0_t4` helper there is the bit-for-bit reference our standalone `turbo3.metal` mirrors)

### QJL (1-bit JL transform K-cache compression)
Reference impl in this repo:

- `packages/native-plugins/qjl-cpu/include/qjl/qjl.h` — public API + `block_qjl1_256` layout
- `packages/native-plugins/qjl-cpu/src/qjl_score_ref.c` — scalar GQA score (the `kernel_attn_score_qjl1_256` mirror target)
- `packages/native-plugins/qjl-cpu/src/qjl_quantize_ref.c` — quantize one row
- `packages/native-plugins/qjl-cpu/src/qjl_dispatch.c` — runtime dispatch (NEON / AVX2 / scalar)

Original CUDA reference (training-side, not the on-device target):
`packages/training/scripts/quantization/qjl/csrc/{qjl_quant_kernel.cu, qjl_gqa_score_kernel.cu}`. The on-fork CPU side that lands `block_qjl1_256` in `ggml-common.h` is W1-A's responsibility; this directory only ports the Metal half.

### PolarQuant (`block_q4_polar`)
Reference impl in this repo:

- `packages/native-plugins/polarquant-cpu/include/polarquant/polarquant.h` — public API + 5-step decode contract
- `packages/native-plugins/polarquant-cpu/include/polarquant/polar_block.h` — `block_q4_polar` packed layout
- `packages/native-plugins/polarquant-cpu/include/polarquant/polar_centroids.h` — `POLAR_Q4_CENTROIDS[16]` Lloyd-Max LUT (the Metal shader inlines the same constants)
- `packages/native-plugins/polarquant-cpu/src/polar_dequantize_ref.c` — scalar decoder (the `kernel_get_rows_q4_polar` mirror target)
- `packages/native-plugins/polarquant-cpu/src/polar_dot_ref.c` — scalar `q4_polar · q8_0` dot product (template for `kernel_mul_mv_q4_polar_f32`, except our verification path uses fp32 activations not q8_0)
- `packages/native-plugins/polarquant-cpu/src/polar_qjl.c` — xorshift32 sign vector for the optional QJL residual
- `packages/native-plugins/polarquant-cpu/src/polar_hadamard.c` — in-place 128-element Walsh-Hadamard butterfly

The on-fork CPU side that adds `block_q4_polar` to `ggml-common.h` is W1-B's
responsibility; this directory only ports the Metal half.

## What each kernel does

### `turbo3` — 3-bit PolarQuant + per-block norm

The graph normalizes a 128-element rotation group, applies a forward Fast
Walsh–Hadamard transform with seed=42 sign vectors, then quantizes each of
the four 32-element sub-blocks to 3-bit Lloyd–Max centroids
`{-0.190685, -0.117832, ..., +0.190685}`. The 3-bit index is split: low 2
bits in `qs[]`, high bit in `signs[]`. Per-group norm is corrected by
`grp_norm / recon_norm` so dequantized output preserves the original L2
norm. At dot-product time, the host has already pre-rotated `Q` with the
same FWHT, so the shader only needs `Q · centroids[idx] * norm`.

### `turbo4` — 4-bit PolarQuant (16 centroids)

Same FWHT pipeline as turbo3, but quantizes to 16 Lloyd–Max centroids
`{-0.241556, ..., +0.241556}` packed 2 indices per byte. Norm correction is
identical. The current `block_turbo4_0` layout is `norm + qs[64]` — it does
NOT include QJL residual signs; that older path was removed upstream. The
milady-ai/llama.cpp fork ships this layout directly in
`ggml/src/ggml-metal/milady-kernels/tbq4_0.metal`, so the on-disk struct
and centroid lookup are bit-identical to this standalone (the historical
`patchMetalTurbo4` runtime rewrite is now a no-op). The kernel *body* has
diverged into perf-only differences (the standalone hoists per-block byte
loads and uses `fma`); see `PATCH_AUDIT_2026-05-10.md` for the diff.

### `turbo3_tcq` — 3-bit Trellis-Coded Quantization (k=3, L=9, 512 states)

Each 128-element rotation group is encoded by a 512-state right-shift
bitshift trellis with a hand-trained 512-entry codebook. Encode = 128-step
Viterbi over 512 states (CUDA: `k_set_rows_turbo3_tcq`); decode = read a
sliding 9-bit window at bit `t*3` of the bitstream and look up the centroid
(CUDA: `dequantize_turbo3_tcq`). Decode-only is what the dot-product path
needs; the Vulkan and Metal shaders here implement decode + Q·K. The
reference C implementation in `reference/turbo_kernels.c` includes a slow
Viterbi encoder for fixture generation.

### `qjl` — 1-bit JL transform K-cache compression

Each 128-element key vector is projected through a fixed 128×256 JL
matrix Π, sign-extracted (256 bits), and stored alongside a bf16 norm
(34 bytes/key total — 7.53× compression vs bf16 K-cache). The
attention-score path consumes a pre-projected query sketch (n_heads ×
proj_dim, computed once per Q) and emits

    score[h_q, t] = ||k_t|| * sqrt(pi/2)/proj_dim *
                    sum_j sign_packed[t, j] * q_sketch[h_q, j]

GQA fanout: `h_kv = h_q / (n_heads/n_kv_heads)`. Three Metal kernels:
`kernel_attn_score_qjl1_256` (the hot path), `kernel_get_rows_qjl1_256`
(decode-to-fp32 fallback), `kernel_mul_mv_qjl1_256_f32` (mat-vec for
non-attention call sites).

### `polar` — 4-bit PolarQuant block (`block_q4_polar`, 82 bytes)

Each 128-element block stores: fp16 per-block L2 norm, 64 bytes of 4-bit
Lloyd-Max-optimal centroid indices, plus 16 bytes of optional 1-bit
QJL residual. Decode steps (mirrors `dequantize_row_q4_polar_ref`):

  1. Unpack 4-bit codes → centroid LUT lookup (16 entries, N(0,1) Lloyd-Max).
  2. Optional QJL residual: 1 sign-bit applied to a deterministic ±1 sign
     vector (xorshift32 seeded with `POLAR_QJL_SEED=42`), magnitude
     `0.5 / sqrt(QK_POLAR)`.
  3. In-place 128-element Walsh-Hadamard butterfly (7 stages).
  4. Compensate by `1/QK_POLAR` to convert the in-place butterfly into the
     orthonormal inverse the Python decoder uses.
  5. Per-block L2 rescale by the stored fp16 norm.

Two Metal kernels: `kernel_get_rows_q4_polar` (full block decode to fp32)
and `kernel_mul_mv_q4_polar_f32` (block-wise dot product against an fp32
activation chunk; one threadgroup per block, `threadgroup`-shared scratch
holds the dequantized block).

## CUDA-to-shader port mapping

Each shader file annotates the CUDA function it ports. Key correspondences:

| Concept                         | CUDA                                                                              | Vulkan                              | Metal                                  |
| ------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------- |
| 3-bit centroid LUT              | `d_turbo_centroids_3bit` (turbo-quant-cuda.cuh:296)                               | `TURBO_CENTROIDS_3BIT` constant     | `TURBO_CENTROIDS_3BIT` constant        |
| 4-bit centroid LUT              | `d_turbo_centroids_4bit` (turbo-quant-cuda.cuh:313)                               | `TURBO_CENTROIDS_4BIT` constant     | `TURBO_CENTROIDS_4BIT` constant        |
| FWHT signs (seed=42)            | `d_turbo_wht_signs1`/`signs2` (turbo-quant-cuda.cuh:326)                          | not applied — Q is pre-rotated      | not applied — Q is pre-rotated         |
| 3-bit dequant                   | `dequantize_turbo3_0` (turbo-quant-cuda.cuh:481)                                  | `vulkan/turbo3.comp` main loop      | `metal/turbo3.metal kernel_turbo3_dot` |
| 4-bit dequant                   | `dequantize_turbo4_0` (turbo-quant-cuda.cuh:532)                                  | `vulkan/turbo4.comp` main loop      | `metal/turbo4.metal kernel_turbo4_dot` |
| TCQ codebook                    | `d_turbo3_tcq_codebook` (turbo-quant-cuda.cuh:619)                                | `binding=3` storage buffer          | `buffer(3)` constant                   |
| TCQ dequant (sliding 9-bit)     | `dequantize_turbo3_tcq` (turbo-quant-cuda.cuh:982)                                | `vulkan/turbo3_tcq.comp` main loop  | `metal/turbo3_tcq.metal kernel_turbo3_tcq_dot` |

### Algorithmic deltas vs CUDA

1. **No on-device encode in the shaders.** The CUDA `k_set_rows_turbo3_tcq`
   does a 512-state Viterbi inside one threadgroup with shared-memory
   double-buffered cost arrays. That requires 512 threads, ~5 KB of
   shared/threadgroup memory, and warp-shuffle min-reduction primitives
   that are tricky to port portably. Encode happens host-side or via the
   C reference impl in `reference/turbo_kernels.c`.

2. **No InnerQ calibration paths.** The CUDA kernels include a `d_innerq_*`
   per-channel scaling pass that is part of the inner-quant calibration
   routine. The decode path does not need it (calibration is a separate
   step that mutates `d_innerq_channel_scale` ahead of quantize). The
   shaders here decode against the post-corrected `norm` field directly.

3. **No `d_tcq_dump_*` debug paths.** The CUDA `k_set_rows_turbo3_tcq` has
   optional global dump buffers for autocorrelation analysis. Removed.

4. **Subgroup/SIMD reduction.** Vulkan uses a driver-portable 32-thread
   shared-memory tree reduction (5 barriers, `shared float partials[32]`)
   so it works regardless of subgroup size. The original `subgroupAdd`
   path silently under-reduced on Intel ARL (minSubgroupSize=8) and on
   lavapipe; W4-A replaced it after on-hardware verification. Metal still
   uses `simd_sum` because the dispatch is one threadgroup = one Apple
   SIMD-group of 32 lanes (the `simd_sum` assumption is a per-vendor
   guarantee on Apple Silicon, unlike Vulkan's driver-chosen subgroup
   size). On AMD GCN/RDNA the Vulkan tree reduction sidesteps the
   wave32/wave64 question entirely.

5. **No FWHT inside the shader.** All shaders skip both forward and inverse
   rotation because the surrounding graph pre-rotates `Q`. This matches
   what the existing fork's Metal `dequantize_turbo3_0_t4` and CUDA
   `dequantize_turbo3_0` actually do — the rotation is a graph-level
   concern, not a per-block concern. **If you wire these shaders into a
   pipeline that does NOT pre-rotate Q, you must add an inverse FWHT to
   the dequantized output before the dot product.**

## Hardware verification protocol

### Mac (Apple Silicon)

```bash
# In this repo's worktree:
cd packages/inference/verify

# 1) Build the reference + fixture generator (no GPU needed):
make reference-test

# 2) Generate fixtures from the reference impl (already shipped under
#    fixtures/, but regenerate if you change the reference):
./gen_fixture fixtures

# 3) Build the Metal harness (requires Xcode command-line tools):
make metal

# 4) Run each shader against the fixtures:
./metal_verify ../metal/turbo3.metal     kernel_turbo3_dot              fixtures/turbo3.json
./metal_verify ../metal/turbo4.metal     kernel_turbo4_dot              fixtures/turbo4.json
./metal_verify ../metal/turbo3_tcq.metal kernel_turbo3_tcq_dot          fixtures/turbo3_tcq.json
./metal_verify ../metal/qjl.metal        kernel_attn_score_qjl1_256     fixtures/qjl.json
./metal_verify ../metal/polar.metal      kernel_mul_mv_q4_polar_f32     fixtures/polar.json

# 5) Optional: end-to-end via the patched llama-server. All four metal
#    kernel patch hooks are opt-in via env vars (default OFF). To opt in:
ELIZA_DFLASH_PATCH_METAL_TURBO3=1 \
ELIZA_DFLASH_PATCH_METAL_QJL=1 \
ELIZA_DFLASH_PATCH_METAL_POLAR=1 \
  bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs --backend metal

# 6) Optional: build the iOS Capacitor static archive that the
#    LlamaCpp.xcframework patch in
#    packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch consumes.
#    Requires macOS host with Xcode installed.
bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs \
  --target ios-arm64-metal
bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs \
  --target ios-arm64-simulator-metal
```

### Android (Vulkan)

```bash
# Host-side: build SPIR-V from the .comp files using glslc from the Vulkan
# SDK (https://vulkan.lunarg.com/sdk/home).
glslc -fshader-stage=compute packages/inference/vulkan/turbo3.comp     -o turbo3.spv
glslc -fshader-stage=compute packages/inference/vulkan/turbo4.comp     -o turbo4.spv
glslc -fshader-stage=compute packages/inference/vulkan/turbo3_tcq.comp -o turbo3_tcq.spv

# Or with glslangValidator if you don't have glslc:
glslangValidator -V -S comp packages/inference/vulkan/turbo3.comp -o turbo3.spv

# 1) On a workstation with a Vulkan-capable GPU (NVIDIA / AMD / Intel),
#    run the host harness:
cd packages/inference/verify
VULKAN_SDK=/opt/vulkan-sdk make vulkan
./vulkan_verify ../vulkan/turbo3.spv     fixtures/turbo3.json
./vulkan_verify ../vulkan/turbo4.spv     fixtures/turbo4.json
./vulkan_verify ../vulkan/turbo3_tcq.spv fixtures/turbo3_tcq.json

# 2) On-device (Android) verification: cross-compile the harness against
#    the Android NDK Vulkan headers and push to a Vulkan-capable handset
#    (Adreno 6xx+, Mali-G7x+). Same SPIR-V, same fixtures.
adb push turbo3.spv turbo4.spv turbo3_tcq.spv /data/local/tmp/eliza-kernels/
adb push fixtures/   /data/local/tmp/eliza-kernels/fixtures/
adb push vulkan_verify /data/local/tmp/eliza-kernels/
adb shell "cd /data/local/tmp/eliza-kernels && \
           ./vulkan_verify turbo3.spv fixtures/turbo3.json"

# 3) End-to-end via llama-server: the patch hook `patchVulkanKernels` is
#    default-on after Wave-4 hardware verification. To silence the log:
ELIZA_DFLASH_PATCH_VULKAN_KERNELS=0 \
  bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs --backend vulkan
```

## Verification matrix (verified locally vs needs hardware)

| Shader            | C reference compiles | Self-test (CPU) | Fixture generated | Static visual review vs CUDA / fork | Compiles to SPIR-V/AIR | Runs on real GPU | Numerically matches CUDA |
| ----------------- | -------------------- | --------------- | ----------------- | ----------------------------------- | ---------------------- | ---------------- | ------------------------ |
| `turbo3.comp`     | n/a                  | n/a             | yes               | yes                                 | yes (Mesa NDK glslc, SPIR-V 1.3 / Vulkan 1.1) | YES — Intel ARL Mesa 25.2.8 + lavapipe Mesa 25.2.8 LLVMpipe | YES — 8/8 PASS, max diff 4.8e-6 |
| `turbo4.comp`     | n/a                  | n/a             | yes               | yes                                 | yes (Mesa NDK glslc, SPIR-V 1.3 / Vulkan 1.1) | YES — Intel ARL Mesa 25.2.8 + lavapipe Mesa 25.2.8 LLVMpipe | YES — 8/8 PASS, max diff 5.7e-6 |
| `turbo3_tcq.comp` | n/a                  | n/a             | yes               | yes                                 | yes (Mesa NDK glslc, SPIR-V 1.3 / Vulkan 1.1) | YES — Intel ARL Mesa 25.2.8 + lavapipe Mesa 25.2.8 LLVMpipe | YES — 8/8 PASS, max diff 6.7e-6 |
| `qjl.comp`, `qjl_get_rows.comp`, `qjl_mul_mv.comp` | n/a | n/a | yes | YES (against `qjl_score_qk_ref`) | yes (glslc 2026.2, SPIR-V 1.3 / Vulkan 1.1, spirv-val clean) | YES — Apple M4 Max via MoltenVK 1.4.1 (Wave-4-C) | YES — 8/8 PASS, max diff 7.6e-6 |
| `polar.comp`, `polar_get_rows.comp` | n/a | n/a | yes | YES (against `dequantize_row_q4_polar_ref` + `polar_dot_ref`) | yes (glslc 2026.2, SPIR-V 1.3 / Vulkan 1.1, spirv-val clean) | YES — Apple M4 Max via MoltenVK 1.4.1 (Wave-4-C) | YES — 8/8 PASS, max diff 5.7e-6 |
| `turbo3.metal`    | n/a                  | n/a             | yes               | YES (matches fork's `dequantize_turbo3_0_t4` byte-for-byte) | YES (Apple M4 Max, runtime JIT) | YES — Apple M4 Max, Darwin 25.2.0 | YES — 8/8 PASS, max diff 3.3e-6 |
| `turbo4.metal`    | n/a                  | n/a             | yes               | The fork's in-tree `milady-kernels/tbq4_0.metal` is an EARLIER draft (29-line diff, materially different inner loop). The standalone is the canonical FMA-tuned variant; the build script copies the standalone into `milady-shipped/` so the metallib uses it. | YES (Apple M4 Max, runtime JIT in verify harness) | YES — Apple M4 Max, Darwin 25.2.0 | YES — 8/8 PASS, max diff 5.7e-6 |
| `turbo3_tcq.metal`| n/a                  | n/a             | yes               | YES (matches CUDA `dequantize_turbo3_tcq` 9-bit window decode) | YES (Apple M4 Max, runtime JIT) | YES — Apple M4 Max, Darwin 25.2.0 | YES — 8/8 PASS, max diff 6.7e-6 |
| `qjl.metal`       | n/a                  | n/a             | yes               | YES (matches `qjl_score_qk_ref` in qjl-cpu)                  | YES (Apple M4 Max, runtime JIT) after Wave-3 attribute-shape fix | YES — Apple M4 Max, Darwin 25.2.0 | YES — 8/8 PASS, max diff 1.1e-5 |
| `polar.metal`     | n/a                  | n/a             | yes               | YES (matches `dequantize_row_q4_polar_ref` + `polar_dot_ref`) | YES (Apple M4 Max, runtime JIT) | YES — Apple M4 Max, Darwin 25.2.0 | YES — 8/8 PASS, max diff 7.6e-6 |
| `turbo_kernels.c` | yes (gcc/clang)      | yes             | yes               | n/a                                 | n/a                    | n/a              | n/a                      |
| `qjl_polar_ref.c` | yes (gcc/clang)      | yes             | yes               | n/a                                 | n/a                    | n/a              | n/a                      |

What "yes" means for the C references: `make reference-test` builds without
warnings (`-O2 -Wall -Wextra -std=c11`), and `./gen_fixture --self-test`
emits finite, plausible-magnitude scores for every kernel:

    turbo3=-2.501480 turbo4=-4.138101 turbo3_tcq=-4.822659 qjl=3.696591 polar=-1.994053

(deterministic with the seeded PRNG in this repo). The same `--self-test`
also runs two internal-consistency parity checks before printing those
scores, so the references can't silently disagree with each other:

  * QJL: `qjl_score_qk` and `qjl_mul_mv` must return the same scalar when
    `n_heads = n_kv_heads = n_tokens = 1` (no GQA fanout, just a single
    projected dot product). Tolerance 1e-5.
  * Polar: `polar_mul_mv` must equal `polar_dequantize_row` reconstructed
    and then manually dotted against `q[]`. Tolerance 1e-3.

These are reference-vs-reference checks; they verify that the two C
references the Metal shaders mirror agree with each other, not that the
shaders agree with hardware. **Metal hardware verification was completed
in Wave-3 (2026-05-10) on Apple M4 Max (Darwin 25.2.0)**: `metal_verify`
reports 8/8 PASS for all five shaders against the fixtures, with max
diff between 3.3e-6 and 1.1e-5 across the suite. The harness uses
`MTLDevice.newLibraryWithSource` (runtime JIT) against `Metal.framework`
— it does NOT require the offline `xcrun metal` toolchain, so any Mac
with Xcode command-line tools can run the verification.
Vulkan QJL/Polar verification (Wave-4-C, 2026-05-10): `verify/vulkan_verify.cpp`
now branches on the fixture's `kernel` field and resolves a per-kernel
`KernelBindings` (input buffer set, output buffer size, push-constant struct,
dispatch shape). QJL gets the 3-buffer (`q_sketch`, `packed_k`, `scores`) +
4-uint push (`n_heads, n_kv_heads, n_tokens, proj_dim`) bind-set with
`(n_heads, n_tokens, 1)` dispatch. Polar gets the 3-buffer (`k_blocks`, `q`,
`y`) + 3-uint push (`n_rows, head_dim, use_qjl`) bind-set with `(n_rows, 1, 1)`
dispatch. The existing turbo3/4/tcq path is unchanged; turbo3_tcq still
attaches the 4th codebook buffer. Same JSON fixture from `gen_fixture` feeds
the Metal and Vulkan harnesses; the QJL/Polar fixture shape fields
(`q_sketch`, `n_heads`, `n_tokens`, `n_rows`, `use_qjl`) were already present.

Hardware run: Apple M4 Max (Darwin 25.2.0) via MoltenVK 1.4.1 + Vulkan-Loader
1.4.341 (`brew install molten-vk vulkan-loader vulkan-headers vulkan-tools
shaderc`; ICD at `/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json`). All 5
kernels (turbo3, turbo4, turbo3_tcq, qjl, polar) report 8/8 PASS at the
standard 1e-3 tolerance with max diffs in the 4.8e-7 to 7.6e-6 range — within
1 ULP of the direct Metal harness numbers, which confirms MoltenVK's
SPIR-V→MSL translation is bit-equivalent on Apple Silicon for these kernels.
Re-run with:

```
brew install molten-vk vulkan-loader vulkan-headers vulkan-tools shaderc
cd packages/inference/verify
make reference-test
make -C ../verify vulkan-spirv      # glslc --target-env=vulkan1.1 --target-spv=spv1.3
c++ -O2 -std=c++17 -I/opt/homebrew/include -I../reference \
    vulkan_verify.cpp turbo_kernels.o qjl_polar_ref.o \
    -L/opt/homebrew/opt/vulkan-loader/lib -lvulkan -lm -o vulkan_verify
export VK_ICD_FILENAMES=/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json
export DYLD_LIBRARY_PATH=/opt/homebrew/opt/vulkan-loader/lib:/opt/homebrew/opt/molten-vk/lib
for k in turbo3 turbo4 turbo3_tcq qjl polar; do
  ./vulkan_verify ../vulkan/$k.spv fixtures/$k.json
done
```

## Substitution note for fixtures

`fixtures/*.json` were generated from the **reference C implementations** in
this directory (`reference/turbo_kernels.c` for the turbo family, plus
`verify/qjl_polar_ref.c` for QJL and Polar), NOT from a real CUDA build of
buun-llama-cpp. They are sufficient to verify that a Vulkan/Metal shader and
the reference produce the same scalar output, but they do NOT verify
CUDA-vs-{Vulkan,Metal} parity.

On hardware-validation day:

  - For TurboQuant: regenerate fixtures from a real CUDA build of
    buun-llama-cpp and replace `turbo3.json`, `turbo4.json`, `turbo3_tcq.json`.
    W1-E owns the CUDA productionization side and can supply these.
  - For QJL: rerun the reference quantize/score path (or the upstream
    `qjl_pure_pytorch_quantize` reference at
    `packages/training/scripts/quantization/qjl/test_qjl.py`) on a CUDA host,
    capture the projected sketch + packed signs + scores, replace `qjl.json`.
  - For PolarQuant: regenerate from `polarquant.polar_quant.py`'s reference
    on a CUDA host (the `_compute_lloyd_max_centroids` and
    `polar_hadamard_inplace` paths are bit-exact targets), replace `polar.json`.

The `block_qjl1_256` and `block_q4_polar` byte layouts are owned by W1-A and
W1-B respectively; the `verify/qjl_polar_ref.{h,c}` files in this directory
are stand-ins that mirror those layouts so the verify harness has zero deps
on the @elizaos/native-plugins packages.

## How standalone shaders flow into the shipped binary

Source-of-truth: the verified `.metal` and `.comp` files in this
directory (`packages/inference/{metal,vulkan}/`). The build script
`packages/app-core/scripts/build-llama-cpp-dflash.mjs` calls into
`packages/app-core/scripts/kernel-patches/{metal,vulkan}-kernels.mjs`
during `applyForkPatches()` and the helpers do the actual work:

### Metal (darwin desktop)

1. The build script forces `-DGGML_METAL_EMBED_LIBRARY=OFF` on every
   `darwin-{arm64,x64}-metal` target. This selects the non-EMBED branch
   of the fork's `ggml/src/ggml-metal/CMakeLists.txt`, which builds a
   sidecar `default.metallib` next to `llama-server`.
2. `patchMetalKernels()` copies the five standalones from
   `packages/inference/metal/{turbo3,turbo4,turbo3_tcq,qjl,polar}.metal`
   into the fork at `ggml/src/ggml-metal/milady-shipped/<name>.metal`.
   Files are copied verbatim; a `// # MILADY-KERNEL-PATCH-V1` comment is
   prepended so an audit can tell they came from the standalone.
3. `patchMetalKernels()` patches
   `ggml/src/ggml-metal/CMakeLists.txt`'s non-EMBED `add_custom_command`
   so the metallib build runs `xcrun metal -c` once per source
   (`ggml-metal.metal` plus each of the five standalones), producing
   one `.air` file each, then merges all six `.air` files into
   `default.metallib` via a single `xcrun metallib` invocation. Sentinel
   `# MILADY-KERNEL-PATCH-V1` makes the patch idempotent.
4. The build install loop copies `default.metallib` from the build's
   `bin/` directory into the install `outDir` next to `llama-server`.
   The Metal runtime locates it via dlopen-style `loader_path` resolution.

After this, `strings default.metallib | grep kernel_turbo3_dot` (and
similarly `kernel_turbo4_dot`, `kernel_turbo3_tcq_dot`,
`kernel_attn_score_qjl1_256`, `kernel_get_rows_qjl1_256`,
`kernel_mul_mv_qjl1_256_f32`, `kernel_get_rows_q4_polar`,
`kernel_mul_mv_q4_polar_f32`) returns matches. The kernels are
present as live symbols inside the metallib.

### Metal (iOS) — deferred

iOS keeps `EMBED_LIBRARY=ON` because the static-archive build needs the
metallib data baked in via `.incbin`. The EMBED path concatenates
`ggml-metal.metal` with `ggml-common.h` via `sed`, and the standalones'
self-contained redefinitions of `block_qjl1_256` / `block_q4_polar` /
`QK_POLAR` / `QK_QJL` / `QJL_RESIDUAL_BYTES` collide. A dup-strip patcher
is filed as a follow-up in `kernel-patches/metal-kernels.mjs`'s module
comment. Until then `requiredKernelsMissing()` refuses iOS metal builds.

### Vulkan — staged but not yet wired

The eight standalone `.comp` files are copied into the fork at
`ggml/src/ggml-vulkan/milady-shipped/<name>.comp` so they are visible
for the next agent to wire up, but `vulkan-shaders-gen` does not yet
know about them and `ggml-vulkan.cpp` has no dispatch sites for the
milady quant types. The patch helper hard-throws when a `*-vulkan`
target is queued unless `ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN=1` is
set as an audit-loggable acknowledgement of the AGENTS.md §3 gap.

### Dispatch wiring (deferred for both Metal and Vulkan)

`ggml-metal-ops.cpp` / `ggml-metal-device.m` (and the Vulkan
equivalents) have no dispatch entries for `GGML_TYPE_TBQ3_0`,
`GGML_TYPE_TBQ4_0`, `GGML_TYPE_TBQ3_TCQ`, `GGML_TYPE_QJL1_256`,
`GGML_TYPE_Q4_POLAR`. CUDA does. This means the kernel symbols are now
present in the Metal `default.metallib` but the runtime cannot select
them via the type-traits table — they ship as dead code until the
dispatch wiring lands. CUDA is the only backend whose v0.4.0-milady
binary fully satisfies AGENTS.md §3 today.

## Build-time environment overrides

| Env var                                  | What it does                                              | Default |
| ---------------------------------------- | --------------------------------------------------------- | ------- |
| `ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN`   | Acknowledge AGENTS.md §3 gap so a `*-vulkan` target builds without turbo/qjl/polar dispatch (audit-loggable). | OFF |
| `ELIZA_DFLASH_LLAMA_CPP_REMOTE`          | Override the fork remote (default `https://github.com/milady-ai/llama.cpp.git`). | unset |
| `ELIZA_DFLASH_LLAMA_CPP_REF`             | Override the fork ref (default `v0.4.0-milady`).          | unset |
| `ELIZA_DFLASH_VULKAN_HEADERS_DIR` / `ELIZA_DFLASH_SPIRV_HEADERS_DIR` | Pre-staged Khronos header paths for cross-builds. | unset |

The previous `ELIZA_DFLASH_PATCH_METAL_*` / `ELIZA_DFLASH_PATCH_VULKAN_KERNELS`
environment knobs were decorative log toggles for the v0.4.0-milady-era
no-op patch hooks. They have been removed; the new patch helpers run
unconditionally on every Metal target and hard-throw on Vulkan unless
the explicit gap-acknowledgement env var is set.

Wiring these into `dflash-server.ts` (so `--cache-type-k turbo3_tcq`
actually runs through the new shader, and so QJL / Polar are reachable
from the CLI) is owned by another agent and depends on the
ggml-metal-ops dispatch work flagged above.

## iOS Capacitor build

The on-device path consumes
[`@elizaos/llama-cpp-capacitor`](https://www.npmjs.com/package/@elizaos/llama-cpp-capacitor)
(currently v0.1.5 from npm), an opaque prebuilt framework. The patch at
`packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch` switches the
plugin to consume a vendored `LlamaCpp.xcframework` so we can ship a
custom-built static archive against the patched fork.

To produce that static archive, the build script now exposes two iOS
targets (compile-only on this machine — they require macOS host with
Xcode):

```bash
bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs --target ios-arm64-metal
bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs --target ios-arm64-simulator-metal
```

Both pass `-DGGML_METAL=ON -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_ARCHITECTURES=arm64`
plus `-DGGML_METAL_EMBED_LIBRARY=ON` so the `.metallib` ships inside the
static archive. Output lands under
`$ELIZA_STATE_DIR/local-inference/bin/dflash/<target>/` as `lib*.a` files
plus a `include/` headers staging directory. A follow-up packaging step
(not in this directory) glues these into the Capacitor xcframework
layout the patch expects.
