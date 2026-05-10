# W4-B CUDA QJL + Polar + TBQ3_TCQ — milady-ai/llama.cpp v0.4.0-milady

**Date:** 2026-05-09
**Wave:** W4 agent B
**Scope:** Port QJL + PolarQuant Q4 + TBQ3_TCQ to CUDA in `milady-ai/llama.cpp`,
land as `milady/cuda-extra`, merge into `milady/integration` as `v0.4.0-milady`.
Compile-only validated — no GPU on this host. Hardware-runtime validation
deferred to the next agent on a real-GPU runner per the W3-D checklist.

## Result

| Done criterion | Status |
|---|---|
| QJL CUDA kernels compile clean for sm_80/86/89/90 | PASS — 3 host wrappers + 3 device kernels in `qjl.cu` |
| Polar CUDA kernels compile clean for sm_80/86/89/90 | PASS — 3 host wrappers + 5 templated device kernels in `polarquant.cu` |
| TBQ3_TCQ CUDA kernels compile clean for sm_80/86/89/90 | PASS — 2 host wrappers + 2 device kernels in `turbo-tcq.cu` |
| Symbol audit: QJL > 0, Polar > 0, TBQ3_TCQ > 0 | PASS — 9 / 10 / 7 (was 0 / 0 / 0 at v0.3.0-milady) |
| `milady/cuda-extra` branch pushed | PASS — `08032d5...` (well, the merge commit) |
| `v0.4.0-milady` tagged + pushed | PASS — annotated tag, see below |
| Consumer pin bumped | PASS — both `build-llama-cpp-dflash.mjs` and `aosp/compile-libllama.mjs` updated to v0.4.0-milady |

## Branch + tag

```
milady/cuda-extra @ 46448b7  (head before merge; see commits below)
milady/integration @ 08032d5 merge: W4-B CUDA ... into milady/integration
v0.4.0-milady       @ 08032d5 (annotated tag, pushed to origin)
```

Commit lineage on `milady/cuda-extra` (4 commits, off `v0.3.0-milady` =
`2baad86`):

```
46448b7 tests: compile-only validation for the W4-B CUDA host wrappers
917af22 cuda: port TBQ3_TCQ trellis-coded decode + dot kernels (W4-B kernel #3)
1f0ccc0 cuda: port PolarQuant Q4 kernels (W4-B kernel #2)
aaa25ba cuda: port QJL 1-bit packed-K kernels (W4-B kernel #1)
2baad86 (v0.3.0-milady) merge: W3-B fused CPU kernels from milady/fused-cpu into milady/integration
```

Push:

```
git push -u origin milady/cuda-extra            -> [new branch]
git push origin milady/integration              -> 82a955e..08032d5
git push origin v0.4.0-milady                   -> [new tag]
```

## Source layout — what changed in the fork

**New files** (under `ggml/src/ggml-cuda/`):

| File | Purpose | Lines |
|---|---|---:|
| `qjl.cuh` | QJL CUDA host API | 83 |
| `qjl.cu` | QJL device kernels (quantize, dequantize, attn_score) | ~280 |
| `polarquant.cuh` | PolarQuant Q4 CUDA host API | 80 |
| `polarquant.cu` | Polar device kernels (dequantize, mul_mat, get_rows w/ F32/F16/BF16 dst templates) | ~430 |
| `turbo-tcq.cuh` | TBQ3_TCQ CUDA host API | 61 |
| `turbo-tcq-codebook.h` | 512-entry codebook (auto-extracted from `packages/inference/reference/turbo_kernels.c`) | 77 |
| `turbo-tcq.cu` | TBQ3_TCQ device kernels (dequantize, mul_mat) | ~234 |

**Modified files:**

| File | Change |
|---|---|
| `ggml/include/ggml.h` | `GGML_TYPE_TBQ3_TCQ = 48` added; `GGML_TYPE_COUNT` bumped to 49 |
| `ggml/src/ggml-common.h` | `block_tbq3_tcq` layout (52 B = fp16 norm + 49-byte qs[] + 1-byte pad) added |
| `ggml/CMakeLists.txt` | 3 new options: `GGML_CUDA_QJL`, `GGML_CUDA_POLARQUANT`, `GGML_CUDA_TBQ3_TCQ` (default ON) |
| `ggml/src/ggml-cuda/CMakeLists.txt` | propagates the 3 macros into `add_compile_definitions` |
| `tests/CMakeLists.txt` | wires `test-cuda-extra-kernels.cpp` (CUDA-only) |
| `tests/test-cuda-extra-kernels.cpp` | new — link-time symbol presence verification |

**No file deleted.** No upstream behavior changed when the new flags are off
(the .cu bodies are wrapped in `#if defined(GGML_CUDA_*)`).

## Per-kernel translation strategy

### QJL — `qjl.cu`

Translated from `packages/training/scripts/quantization/qjl/csrc/{qjl_quant_kernel.cu,
qjl_score_kernel.cu}`. Stripped:

- torch::extension / pybind11 plumbing
- training-only outlier-hashing path (calibration counters, calibration
  outputs, two distinct quantize codepaths)
- L2 persistent cache stream attribute setup (L2 hint is a fp32-projection
  optimization specific to long-running training jobs; production inference
  KV-cache stores blocks once per token)

Math reference: `packages/native-plugins/qjl-cpu/src/{qjl_quantize_ref.c,
qjl_score_ref.c}`. Contracts:
- 1-bit signs are LSB-first within byte.
- bf16 norm conversion is round-to-nearest-even (matches `qjl_fp32_to_bf16`).
- Score uses `scl = sqrt(pi/2) / proj_dim * norm`.

Three host entry points:
- `quantize_row_qjl1_256_cuda(x_d, y_d, nrows, prj_d, stream)`
- `dequantize_row_qjl1_256_cuda(x_d, y_d, nrows, prj_d, stream)`
- `attn_score_qjl_cuda(q_sketch_d, packed_k_d, n_heads, n_kv_heads, n_kv_tokens, scores_d, stream)`

Block geometry:
- **quantize:** 1 block / row, 256 threads (one per sketch dim). Cooperative
  load of the row's 128 fp32 keys into shared, per-thread sketch[j] dot
  product, warp ballot to pack signs. Norm via 4-warp shfl_xor reduce.
- **dequantize:** 1 block / row, 128 threads (one per head_dim output).
  Loads 32 sign bytes into shared once, per-thread inner product.
- **attn_score:** grid (n_heads, n_kv_tokens), 32 threads/block (= 1 warp).
  Each thread handles one of the 32 sign bytes (= 8 sketch dims), warp
  shfl_xor reduce, single scalar write per (hq, t).

Tensor Cores: not used in this revision. The score kernel's hot path is
a 32-thread reduction of byte-bit dot products; it's already memory-bound
on the 32 B/token K-cache fetch, and switching to mma.sync would require
materializing 256 fp32 sketch entries per query head per token (32× more
work for the same answer). Document this in `qjl.cu` as a future-work
note but defer until a real GPU profile says otherwise.

### Polar — `polarquant.cu`

Translated from `packages/native-plugins/polarquant-cpu/src/{polar_dequantize_ref.c,
polar_dot_ref.c, polar_hadamard.c, polar_qjl.c}`.

Bit parity contracts vs. CPU reference:
- 16 Lloyd-Max centroids: bit-exact match for `POLAR_Q4_CENTROIDS`
  (`__constant__ k_polar_q4_centroids_cuda` mirrors the CPU header).
- WHT butterfly: same iteration order (h=1,2,...,64), same in-place
  add/sub, same 1/QK_POLAR scale compensation.
- QJL residual: same xorshift32(seed=POLAR_QJL_SEED=42) sign sequence,
  same magnitude POLAR_QJL_CORRECTION_MAGNITUDE=0.5/sqrt(QK_POLAR).

Three host entry points:
- `dequantize_row_q4_polar_cuda(x_d, y_d, nrows, use_qjl, stream)`
- `mul_mat_q4_polar_q8_0_cuda(x_d, y_d, dst_d, nrows_x, nrows_y, n_per_row, use_qjl, stream)`
- `get_rows_q4_polar_cuda(...)` — templated on F32 / F16 / BF16 dst

Block geometry:
- **dequantize:** 1 block / polar block, 128 threads (one per output
  element). 4-bit unpack + LUT is parallelized; the 7-stage WHT runs
  serially on thread 0 (448 ops, dwarfed by the rest).
- **mul_mat:** grid (nrows_x, nrows_y), 128 threads/block. Walks
  n_per_row/QK_POLAR Polar blocks and accumulates against the matching
  4 Q8_0 blocks per Polar block.
- **get_rows:** grid (n_polar_per_row, ne10, ne11*ne12), 128 threads/block.
  Templated on the dst type so F16 / BF16 cache-fill goes through the
  same code path.

### TBQ3_TCQ — `turbo-tcq.cu`

Translated from `packages/inference/reference/turbo_kernels.c::eliza_dequantize_turbo3_tcq_block`.
Encoder (Viterbi) stays host-side per task brief.

Decode: for symbol t, read 9-bit window starting at bit_pos=t*3, look up
`codebook[state] * norm`. The 9-bit window has no cross-symbol dependency
at decode time so all 128 symbols decode in parallel.

Two host entry points:
- `dequantize_row_tbq3_tcq_cuda(x_d, y_d, nrows, stream)`
- `mul_mat_tbq3_tcq_q8_0_cuda(x_d, y_d, dst_d, nrows_x, nrows_y, n_per_row, stream)`

Block geometry: 1 block / TCQ block (or 1 / output cell), 128 threads/block.
qs[] is loaded into shared once per TCQ block to avoid 128 redundant global
loads; 4-warp block-level reduction for mul_mat.

The 512-entry codebook lives in `__constant__ k_tbq3_tcq_codebook_cuda`
mirrored from `turbo-tcq-codebook.h` (auto-extracted from the reference C
file — no hand-tuned constants).

## Build flags

Three new options gated at `ggml/CMakeLists.txt`:

```cmake
option(GGML_CUDA_QJL        "ggml: compile QJL 1-bit packed-K KV-cache CUDA kernels"  ON)
option(GGML_CUDA_POLARQUANT "ggml: compile PolarQuant Q4 CUDA kernels"                ON)
option(GGML_CUDA_TBQ3_TCQ   "ggml: compile TBQ3_TCQ trellis-coded CUDA kernels"       ON)
```

Mode: default ON when `GGML_CUDA=ON`. The .cu files are unconditionally
globbed by the existing CMakeLists; the bodies are wrapped in
`#if defined(GGML_CUDA_*)`. With the flag off, each .cu compiles to an
empty translation unit, no symbols emitted.

## Per-kernel compile status

```
qjl sm_80 : OK 131272 bytes (PTX)
qjl sm_86 : OK 131272 bytes (PTX)
qjl sm_89 : OK 131272 bytes (PTX)
qjl sm_90 : OK 131272 bytes (PTX)
polarquant sm_80 : OK 237368 bytes (PTX)
polarquant sm_86 : OK 237368 bytes (PTX)
polarquant sm_89 : OK 237368 bytes (PTX)
polarquant sm_90 : OK 237368 bytes (PTX)
turbo-tcq sm_80 : OK 119634 bytes (PTX)
turbo-tcq sm_86 : OK 119634 bytes (PTX)
turbo-tcq sm_89 : OK 119634 bytes (PTX)
turbo-tcq sm_90 : OK 119634 bytes (PTX)
```

PTX dumps live at `/tmp/w4b-ptx/*.ptx` (12 files, ~5.8 MB total). md5s in
`/tmp/w4b-ptx/md5sums.txt`. PTX header consistent with W3-D's evidence —
`Compiler Build ID: CL-35059454`, `Cuda compilation tools, release 12.6, V12.6.85`,
`.version 8.5`.

PTX entry counts (each `.visible .entry` is one launchable device function):

```
qjl-sm80.ptx       — 3 entries: qjl_quantize_kernel, qjl_dequantize_kernel, qjl_score_kernel
polarquant-sm80.ptx — 5 entries: polar_dequantize_kernel<float>,
                                  polar_mul_mat_q4_polar_q8_0_kernel,
                                  polar_get_rows_kernel<float|half|nv_bfloat16>
turbo-tcq-sm80.ptx — 2 entries: tbq3_tcq_dequantize_kernel, tbq3_tcq_mul_mat_kernel
```

10 device kernels total across the three new files. Each kernel compiles
with all 4 archs in the matrix; the `--generate-code arch=compute_X,code=...`
pass-through emits per-arch real code via cmake's normal multi-arch flow.

## Symbol verification — `libggml-cuda.so`

Single-arch (sm_80) build first to confirm linkage, then full multi-arch:

```bash
cmake -B build-cuda -DGGML_CUDA=ON \
  -DCMAKE_CUDA_COMPILER=/home/shaw/cuda/bin/nvcc \
  -DCMAKE_CUDA_ARCHITECTURES="80;86;89;90" \
  -DGGML_CUDA_FA=ON -DGGML_CUDA_FA_ALL_QUANTS=ON \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON -DLLAMA_CURL=OFF
cmake --build build-cuda --target ggml-cuda -j$(nproc)
```

Symbol table (single-arch sm_80 build, definitive count):

| Family | Count | Symbols |
|---|---:|---|
| QJL | 9 | `quantize_row_qjl1_256_cuda`, `dequantize_row_qjl1_256_cuda`, `attn_score_qjl_cuda` (host wrappers) + 3 kernels + 3 `__device_stub__*` |
| Polar | 10 | `dequantize_row_q4_polar_cuda`, `mul_mat_q4_polar_q8_0_cuda`, `get_rows_q4_polar_cuda` (host wrappers) + 5 templated kernels + 1 mul_mat device stub + 1 `k_polar_q4_centroids_cuda` constant |
| TBQ3_TCQ | 7 | `dequantize_row_tbq3_tcq_cuda`, `mul_mat_tbq3_tcq_q8_0_cuda` (host wrappers) + 2 kernels + 2 `__device_stub__*` + 1 `k_tbq3_tcq_codebook_cuda` constant |

Existing TBQ3_0 / TBQ4_0 symbols preserved (88 — same count as v0.3.0
per the W3-D audit).

## Tests

`tests/test-cuda-extra-kernels.cpp` is a compile-only link verification:

- 8 `extern "C"` host wrappers declared.
- Function-pointer table referenced through `void * table[] = {...}`.
- If any symbol fails to resolve, link step fails with `undefined reference
  to 'attn_score_qjl_cuda'` (or similar).
- At runtime, the test never invokes a kernel — the host has no NVIDIA
  driver bound. It prints `[ok] QJL CUDA: 3 host wrappers linkable`
  (plus the analogous lines for Polar and TBQ3_TCQ) and exits 0.

This test is gated on `GGML_CUDA=ON`. When the matching feature macro is
off it prints `[skip]` for that family.

Wired into `tests/CMakeLists.txt` under the existing `if (NOT WIN32)` test
block, between `test-fused-kernels` and the bench.

## Hardware-runner checklist (for the next agent)

To convert this compile-only verification into real-GPU runtime:

1. **GPU**: NVIDIA hardware with sm_80/86/89/90 and CUDA 12.6+ runtime.
   Single-GPU is enough for per-arch correctness; multi-GPU for the matrix.
2. **Driver**: NVIDIA R555+ bound to the device. `nvidia-smi` should list it.
3. **Build identical to this report's invocation**, then run:
   - `./build-cuda/bin/test-cuda-extra-kernels` — should print all 3 `[ok]` lines, exit 0.
   - `./build-cuda/bin/test-backend-ops -o ATTN_SCORE_QJL` (once the CUDA
     dispatcher entry is wired — out of scope for compile-only). Pass
     criterion: numerical match with the CPU forward path within fp32 epsilon.
4. **Per-kernel correctness**:
   - QJL: round-trip a synthetic 8x128 fp32 key tensor through
     `quantize_row_qjl1_256_cuda` -> `dequantize_row_qjl1_256_cuda` and
     compare against `qjl_dequantize_row_ref` from
     `packages/native-plugins/qjl-cpu/src/qjl_quantize_ref.c`. Tolerance
     should match the JL transform variance (the W1-A test file
     `tests/test-qjl-cache.cpp` documents the expected error envelope).
   - Polar: round-trip via `dequantize_row_q4_polar_cuda` and compare
     against `dequantize_row_q4_polar_ref` from
     `packages/native-plugins/polarquant-cpu/`. Bit-exact match expected
     (all centroids and the WHT are deterministic).
   - TBQ3_TCQ: round-trip via `dequantize_row_tbq3_tcq_cuda` and compare
     against `eliza_dequantize_turbo3_tcq_block` from
     `packages/inference/reference/turbo_kernels.c`. Bit-exact match
     expected (the 9-bit window decode + multiply is deterministic).
5. **Throughput**: KV-cache hot loop. Compare TBQ3_TCQ against TBQ3_0 +
   TBQ4_0 on the same workload (Wikitext-2 first 256 tokens, 8B-class
   model, Qwen3-shaped GQA). TCQ should be at parity with TBQ3_0 on
   reconstruction MSE while consuming the same bytes/block.

Same machine setup details otherwise as W3-D's report.

## Consumer pin bumps

Two scripts in the milady eliza worktree updated:

- `packages/app-core/scripts/build-llama-cpp-dflash.mjs`:
  `REF` default `v0.2.0-milady` -> `v0.4.0-milady`.
- `packages/app-core/scripts/aosp/compile-libllama.mjs`:
  `LLAMA_CPP_TAG` `v0.2.0-milady` -> `v0.4.0-milady`,
  `LLAMA_CPP_COMMIT` `7c7818aa...` -> `08032d57e15574f2a7ca19fc3f29510c8673d590`.

The AOSP path stays CPU-only at runtime (the new CUDA kernels are dead
code on arm64-android), but the pin is shared so both build paths land
on identical kernel sources.

## Out of scope

- Real-GPU runtime tests (no GPU here — handed off via the checklist above).
- Vulkan kernels (W4-A's job).
- sm_100 / Blackwell — CUDA 12.6 doesn't accept sm_100, and the cmake
  glob already handles 12Xa rewrites for forward-compat targets.
- ROCm / HIP — neither toolkit is on this host.
- ggml-cuda dispatcher wiring for `GGML_OP_ATTN_SCORE_QJL`,
  `GGML_OP_FUSED_ATTN_QJL_TBQ`, and the new mul_mat / get_rows entries
  for QJL1_256 / Q4_POLAR / TBQ3_TCQ. Those wirings need a real GPU to
  validate dispatch correctness; a follow-up agent will land them
  alongside the hardware tests above. The host wrappers exist and are
  linkable, so the dispatcher work is purely additive.

## Files in this report

| File | Purpose |
|---|---|
| `cuda-extra.md` | this file |
| `baseline-pre-fix.txt`, `post-fix.txt` | (pre-existing W4 artifacts from a sibling agent — left in place, not produced here) |

PTX dumps and md5s are at `/tmp/w4b-ptx/` (~5.8 MB, not committed; re-create
with the per-arch loop in the report's "Per-kernel compile status" section
or via the W3-D probe script `reports/porting/2026-05-09-w3/probe-cuda-compile-only.sh`
pointed at `~/work-cuda-extra/llama.cpp`).
