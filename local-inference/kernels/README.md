# DRAFT TurboQuant KV cache kernels (Vulkan + Metal)

> **DRAFT — DO NOT ENABLE IN PRODUCTION UNTIL VERIFIED ON HARDWARE.**
>
> These shaders were ported from buun-llama-cpp's CUDA reference without a GPU
> available to the agent that wrote them. They are textually consistent with
> the CUDA originals and pass a CPU-vs-CPU sanity test, but they have NEVER
> been compiled by a real shader toolchain or executed on real hardware.

## Source of truth

CUDA originals: `https://github.com/spiritbuun/buun-llama-cpp.git` at commit
`6575873e9c4872709d374d854b583cfaa270caff`, paths:

- `ggml/src/ggml-cuda/turbo-quant-cuda.cuh` — quantize/dequantize, codebooks, FWHT, Viterbi
- `ggml/src/ggml-cuda/fattn-vec.cuh` — flash-attention vec path that consumes them
- `ggml/src/ggml-common.h` — `block_turbo3_0`, `block_turbo4_0`, `block_turbo3_tcq` layouts
- `ggml/src/ggml-cpu/ops.cpp` and `ggml/src/ggml-turbo-quant.c` — CPU reference (lossy stubs)
- `ggml/src/ggml-metal/ggml-metal.metal` and `turbo-wht.h` — existing Metal shader ground truth

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
./metal_verify ../metal/turbo3.metal     kernel_turbo3_dot     fixtures/turbo3.json
./metal_verify ../metal/turbo4.metal     kernel_turbo4_dot     fixtures/turbo4.json
./metal_verify ../metal/turbo3_tcq.metal kernel_turbo3_tcq_dot fixtures/turbo3_tcq.json

# 5) Optional: end-to-end via the patched llama-server. The patch hook
#    `patchMetalTurbo3Tcq` (gated by ELIZA_DFLASH_PATCH_METAL_TURBO3=1) is
#    the only step that wires the new kernel into the production library.
#    Default: OFF. To opt in:
ELIZA_DFLASH_PATCH_METAL_TURBO3=1 \
  bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs --backend metal
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

| Shader            | C reference compiles | Self-test (CPU) | Fixture generated | Static visual review vs CUDA | Compiles to SPIR-V/AIR | Runs on real GPU | Numerically matches CUDA |
| ----------------- | -------------------- | --------------- | ----------------- | ---------------------------- | ---------------------- | ---------------- | ------------------------ |
| `turbo3.comp`     | n/a                  | n/a             | yes               | yes                          | NEEDS HARDWARE          | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo4.comp`     | n/a                  | n/a             | yes               | yes                          | NEEDS HARDWARE          | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo3_tcq.comp` | n/a                  | n/a             | yes               | yes                          | NEEDS HARDWARE          | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo3.metal`    | n/a                  | n/a             | yes               | yes                          | NEEDS HARDWARE          | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo4.metal`    | n/a                  | n/a             | yes               | yes                          | NEEDS HARDWARE          | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo3_tcq.metal`| n/a                  | n/a             | yes               | yes                          | NEEDS HARDWARE          | NEEDS HARDWARE   | NEEDS HARDWARE           |
| `turbo_kernels.c` | yes (gcc/clang)      | yes             | yes               | n/a                          | n/a                    | n/a              | n/a                      |

What "yes" means for the C reference: `make reference-test` builds without
warnings (`-O2 -Wall -Wextra -std=c11`), and `./gen_fixture --self-test`
emits finite, plausible-magnitude scores for all three kernels (turbo3 ≈ -2.5,
turbo4 ≈ -4.1, turbo3_tcq ≈ -4.8 with the seeded PRNG in this repo). What
"NEEDS HARDWARE" means: no shader compiler (`glslangValidator`, `glslc`,
`xcrun metal`) is installed in this environment, so even the textual SPIR-V
/ AIR compile step is unverified. The shaders are written to match the CUDA
originals exactly and were cross-read against the existing fork Metal
shader at `ggml/src/ggml-metal/ggml-metal.metal`, but that is not a
substitute for `glslc` and `xcrun metal`.

## Substitution note for fixtures

`fixtures/*.json` were generated from the **reference C implementation**, NOT
from a real CUDA build of buun-llama-cpp. They are sufficient to verify that
a Vulkan/Metal shader and the reference produce the same scalar output, but
they do NOT verify CUDA-vs-{Vulkan,Metal} parity. On hardware-validation
day, regenerate fixtures from a real CUDA build and replace these files.

## Feature-flag gating

These kernels are **never on the production code path** unless explicitly
opted in. The build script (`packages/app-core/scripts/build-llama-cpp-dflash.mjs`)
adds two NEW patch hooks, both default-OFF:

| Env var                                  | What it does                                       | Default |
| ---------------------------------------- | -------------------------------------------------- | ------- |
| `ELIZA_DFLASH_PATCH_VULKAN_KERNELS=1`    | Drops `vulkan/*.comp` into the fork's Vulkan tree  | OFF     |
| `ELIZA_DFLASH_PATCH_METAL_TURBO3=1`      | Drops `metal/*.metal` into the fork's Metal tree   | OFF     |

Wiring these into `dflash-server.ts` (so `--cache-type-k turbo3_tcq` actually
runs through the new shader) is owned by another agent. This patch only
makes the source available to the build.
