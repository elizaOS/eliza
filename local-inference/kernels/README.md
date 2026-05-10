# DRAFT TurboQuant / QJL / PolarQuant KV cache kernels (Vulkan + Metal)

> **DRAFT — COMPILED ONLY ON LINUX, NOT VALIDATED ON GPU HARDWARE.**
>
> | Family       | Files                                                            | Source-level checked against fork? | Compiled with target SDK? | Validated on hardware? |
> | ------------ | ---------------------------------------------------------------- | ---------------------------------- | ------------------------- | ---------------------- |
> | TurboQuant   | `metal/turbo3.metal`, `metal/turbo4.metal`, `metal/turbo3_tcq.metal`, `vulkan/turbo*.comp` | YES (byte layout + decode math match in-tree `dequantize_turbo3_0_t4` and the always-on `patchMetalTurbo4`) | NO (no `xcrun metal` / `glslc` in author env beyond the NDK build) | NO |
> | QJL          | `metal/qjl.metal` (new)                                          | YES (against `qjl_score_qk_ref` in `packages/native-plugins/qjl-cpu`) | NO | NO |
> | PolarQuant   | `metal/polar.metal` (new)                                        | YES (against `dequantize_row_q4_polar_ref` + `polar_dot_ref` in `packages/native-plugins/polarquant-cpu`) | NO | NO |
>
> Earlier history: the original `turbo*.comp` Vulkan port reported 0/8 PASS
> against Mesa llvmpipe (subgroup-size mismatch + structural divergence).
> The Metal ports here mirror the **same** decode math as the fork's existing,
> shipping `dequantize_turbo3_0_t4` and the always-on `patchMetalTurbo4` patch
> — so the byte layout and centroid lookup have been triple-checked at the
> source level. None of that is a substitute for `metal_verify` reporting
> 8/8 PASS on a real Apple GPU.
>
> **Do not wire these into the production fork on the always-on path** until
> hardware verification lands. The build-script patch hooks
> (`patchMetalTurbo3Tcq`, `patchMetalQjl`, `patchMetalPolar`) are all
> opt-in via env vars (`ELIZA_DFLASH_PATCH_METAL_*=1`) for that reason.
> `patchMetalTurbo4` remains always-on because it predates these standalone
> shaders and rewrites the fork's stale Turbo4 path to match the current
> `block_turbo4_0` layout (norm + qs[64], no QJL residuals).
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
NOT include QJL residual signs; that older path was removed upstream and
the in-tree Metal patch (`scripts/build-llama-cpp-dflash.mjs:181`,
`patchMetalTurbo4`) brings the fork's stale Metal shader in line with the
current layout. This standalone shader matches the new layout directly.

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

4. **Subgroup/SIMD reduction.** Vulkan uses
   `GL_KHR_shader_subgroup_arithmetic` `subgroupAdd`; Metal uses
   `simd_sum`. Both assume a 32-lane subgroup/SIMD-group, which matches
   nVidia warps and Apple GPU SIMD-groups. On AMD GCN/RDNA the wave size
   may be 32 or 64 — verify on hardware.

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
cd local-inference/kernels/verify

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
glslc -fshader-stage=compute local-inference/kernels/vulkan/turbo3.comp     -o turbo3.spv
glslc -fshader-stage=compute local-inference/kernels/vulkan/turbo4.comp     -o turbo4.spv
glslc -fshader-stage=compute local-inference/kernels/vulkan/turbo3_tcq.comp -o turbo3_tcq.spv

# Or with glslangValidator if you don't have glslc:
glslangValidator -V -S comp local-inference/kernels/vulkan/turbo3.comp -o turbo3.spv

# 1) On a workstation with a Vulkan-capable GPU (NVIDIA / AMD / Intel),
#    run the host harness:
cd local-inference/kernels/verify
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

# 3) End-to-end via llama-server: the patch hook `patchVulkanKernels`
#    (gated by ELIZA_DFLASH_PATCH_VULKAN_KERNELS=1) drops these .comp
#    files into the fork's Vulkan backend. Default: OFF.
ELIZA_DFLASH_PATCH_VULKAN_KERNELS=1 \
  bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs --backend vulkan
```

## Verification matrix (verified locally vs needs hardware)

| Shader            | C reference compiles | Self-test (CPU) | Fixture generated | Static visual review vs CUDA / fork | Compiles to SPIR-V/AIR | Runs on real GPU | Numerically matches CUDA |
| ----------------- | -------------------- | --------------- | ----------------- | ----------------------------------- | ---------------------- | ---------------- | ------------------------ |
| `turbo3.comp`     | n/a                  | n/a             | yes               | yes                                 | NEEDS HARDWARE         | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo4.comp`     | n/a                  | n/a             | yes               | yes                                 | NEEDS HARDWARE         | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo3_tcq.comp` | n/a                  | n/a             | yes               | yes                                 | NEEDS HARDWARE         | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo3.metal`    | n/a                  | n/a             | yes               | YES (matches fork's `dequantize_turbo3_0_t4` byte-for-byte) | NEEDS HARDWARE         | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo4.metal`    | n/a                  | n/a             | yes               | YES (matches always-on `patchMetalTurbo4` decode path)       | NEEDS HARDWARE         | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo3_tcq.metal`| n/a                  | n/a             | yes               | YES (matches CUDA `dequantize_turbo3_tcq` 9-bit window decode) | NEEDS HARDWARE         | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `qjl.metal`       | n/a                  | n/a             | yes               | YES (matches `qjl_score_qk_ref` in qjl-cpu)                  | NEEDS HARDWARE         | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `polar.metal`     | n/a                  | n/a             | yes               | YES (matches `dequantize_row_q4_polar_ref` + `polar_dot_ref`) | NEEDS HARDWARE         | NEEDS HARDWARE   | NEEDS HARDWARE           |
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
shaders agree with hardware. What "NEEDS HARDWARE"
means: no shader compiler (`glslangValidator`, `glslc`, `xcrun metal`) is
installed in the agent's working environment, so even the textual SPIR-V /
AIR compile step is unverified. The shaders are written to match the
fork's existing in-tree Metal helpers (where they exist) plus the on-fork
CPU references for QJL and Polar bit-for-bit, but **that is not a
substitute for `xcrun metal` followed by `metal_verify` reporting 8/8 PASS
on a real Apple Silicon device**. AGENTS.md is explicit about this
constraint — do not regenerate this matrix to ✓ until the hardware run
actually happens.

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

## Feature-flag gating

These kernels are **never on the production code path** unless explicitly
opted in. The build script (`packages/app-core/scripts/build-llama-cpp-dflash.mjs`)
exposes the following patch hooks:

| Env var                                  | What it does                                              | Default |
| ---------------------------------------- | --------------------------------------------------------- | ------- |
| `ELIZA_DFLASH_PATCH_VULKAN_KERNELS=1`    | Drops `vulkan/*.comp` into the fork's Vulkan tree         | OFF     |
| `ELIZA_DFLASH_PATCH_METAL_TURBO3=1`      | Drops `metal/turbo3*.metal` into the fork's Metal tree    | OFF     |
| `ELIZA_DFLASH_PATCH_METAL_QJL=1`         | Drops `metal/qjl.metal` into the fork's Metal tree        | OFF     |
| `ELIZA_DFLASH_PATCH_METAL_POLAR=1`       | Drops `metal/polar.metal` into the fork's Metal tree      | OFF     |

`patchMetalTurbo4` is **always on** during Metal builds — it predates these
standalone shaders and rewrites the fork's stale Turbo4 path to match the
current `block_turbo4_0` layout. Do not flip the four hooks above to
always-on until `metal_verify` reports 8/8 PASS on real Apple Silicon
hardware.

Wiring these into `dflash-server.ts` (so `--cache-type-k turbo3_tcq`
actually runs through the new shader, and so QJL / Polar are reachable
from the CLI) is owned by another agent. This patch only makes the source
available to the build.

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
