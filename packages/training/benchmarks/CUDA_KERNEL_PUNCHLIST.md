# Fork CUDA kernel survey — eliza-1 custom quant types

Survey date 2026-05-11. **READ-ONLY** — the fork (`~/.cache/eliza-dflash/
eliza-llama-cpp/`) is under a concurrent rewrite; this is a punch-list for the
inference team, not a set of edits. Target hardware: RTX 5080 Laptop
(16 GB, Blackwell **sm_120**), CUDA 13 runtime, system nvcc 12.0. A working
CUDA build of the fork is at `build-cuda/`. Current build targets
`89-real;90-real;90-virtual` → driver JITs sm_90 PTX to sm_120 (works, but no
`tcgen05` MMA / FP4).

Files surveyed:
`ggml/src/ggml-cuda/{polarquant.cu,polarquant.cuh,qjl.cu,qjl.cuh,turbo-tcq.cu,
turbo-tcq.cuh,turboquant.cuh}`,
`fattn-common.cuh` (the `vec_dot_fattn_vec_KQ_tbq*` / `dequantize_V_tbq*`
helpers), `fattn-vec.cuh`, the `template-instances/fattn-vec-instance-tbq{3,4}_0-*.cu`,
`ggml-common.h` block defs (`block_q4_polar`, `block_qjl1_256`,
`block_tbq3_0`, `block_tbq4_0`, `block_tbq3_tcq`).

**Naming note:** the task brief mentions
`fattn-vec-instance-{qjl1_256,q4_polar}*.cu` — those do **not** exist in the
tree. The only custom fattn-vec instances are `tbq3_0`/`tbq4_0` (4 files).
`Q4_POLAR`/`QJL1_256` are *not* wired into flash-attention at all (PolarQuant
is a weight type with its own `mul_mat`/`get_rows`/`dequantize_row` kernels in
`polarquant.cu`; QJL has standalone `quantize`/`dequantize`/`score` kernels in
`qjl.cu`). That gap is itself a punch-list item (see #5).

---

## Per-file assessment

### 1. `turbo-tcq.cu` — TBQ3_TCQ decode + `mul_mat` (× Q8_0)
- **Block geometry:** one CUDA block per quant block, 128 threads, one symbol
  per thread. `qs[49]` staged in `__shared__` once at block entry — good.
- **Codebook:** 512-entry fp32 codebook in `__constant__` memory — correct,
  device reads hit the constant cache. The decode is a single
  `codebook[state] * norm` per thread after a 9-bit sliding-window unpack
  (`tbq3_tcq_extract_state`, ≤2 byte read). Clean, branch-light. No spills.
- **Vectorization:** `qs[]` load is byte-at-a-time (`if (tid < 49)`), not
  `int4`-vectorized; 49 bytes isn't aligned to 16 so a single `int4` won't
  cover it, but 12×`uint32` + 1 byte would halve the load instructions.
  Minor.
- **`mul_mat` path:** grid `(nrows_x, nrows_y)`, one block per output element.
  Inside, `s_qs[49]` is re-loaded and `__syncthreads()`-ed **per quant block
  in the row loop** — for a row of length `n_per_row`, that's `n_per_row/128`
  shared-load+barrier round-trips, and the dst is one fp32 scalar per
  `(row_x,row_y)` so there's no output reuse: this is a pure GEMV-with-decode,
  not a tiled GEMM. Fine for `tg` (the decode-bound regime), poor for `pp`
  (prefill should be a tiled MMA, see #3). Block reduction uses
  `__shfl_xor_sync` + a 4-element `s_partial[]` — correct, standard.
- **Fusion:** decode *is* fused into the dot (no separate dequant→fp32→GEMM
  bounce). Good — keep it.
- **Blackwell:** this is a "vec" (no-tensor-core) kernel. A native sm_120
  build won't speed it up without a structural rewrite to take an MMA tile
  (decode-into-shared then `tcgen05`/wgmma on the fp32 tile). For `tg` that's
  not worth it (decode-bound, not flop-bound); for `pp` it is — but `pp` for
  the eliza-1 sizes already routes weights through cuBLAS after a separate
  dequant, so TBQ3_TCQ-as-weights would need the dequant-into-MMA path.
- **Benefit: low / Effort: low** for the vectorized `qs[]` load and dropping
  the per-block barrier in `mul_mat` (decode all blocks into a register array
  per thread, then one reduction). **Benefit: med / Effort: high** for an
  MMA-tile prefill path.

### 2. `turboquant.cuh` — TBQ3_0 / TBQ4_0 decode (the KV-cache types used by flash-attn)
- **This is the hot path.** `tbq_decode_block_cuda(block, float[32])` =
  `tbq_decode_rotated` (8/16-entry codebook lookup ×32) → `tbq_uncondition`
  = a **full size-32 Walsh-Hadamard transform** (`tbq_hadamard32_cuda`:
  `5·16 = 80` butterfly ops + 32 normalizations) → 32 sign flips. Codebooks
  (`k_tbq3_codebook_cuda[8]`, `k_tbq4_codebook_cuda[16]`) and the sign vector
  (`k_tbq_signs_cuda[32]`) are `static constexpr __device__` — these land in
  per-TU constant/immediate space, fine.
- **The problem:** in `fattn-common.cuh::vec_dot_fattn_vec_KQ_tbq` and
  `dequantize_V_tbq`, **every thread calls `tbq_decode_block_cuda` on the
  whole 32-element block** to then use only `cpy_ne` (typ. 2–4) of the 32
  decoded values. With `nthreads_KQ = 128/cpy_nb` threads cooperating on a
  D=128 head, each 32-element K sub-block is decoded **redundantly by
  `32/cpy_ne` ≈ 8–16 threads** — i.e. the size-32 WHT is recomputed ~8–16×
  per K vector. That's the single biggest waste in the custom-KV flash-attn
  path: a 32-element WHT (~112 fp ops) ×16 redundant = ~1.8k fp ops/Kvec just
  for decode, vs ~256 for the actual Q·K dot. Also each call allocates
  `__align__(16) float block[QK_TBQ]` (32 floats = 128 B) **in registers** —
  on a 128-thread block that's a real register-pressure hit and likely the
  cause of any occupancy drop on this kernel.
- **Fix:** decode each 32-element K (and V) sub-block **once into shared
  memory** per CUDA block (one warp does the WHT, `__syncthreads`, everyone
  reads the fp16/fp32 tile) instead of per-thread-redundant register decode —
  exactly the staging the F16 path already gets. Cuts decode flops ~8–16×,
  kills the `float[32]`-in-registers spill, and lets the inner Q·K loop be a
  clean `half2`/`float2` MAC over shared. This is the highest-leverage kernel
  change in the whole survey.
- **Vectorization:** the 3-bit unpack (`tbq3_get_code_cuda`) is a per-element
  shift/mask with a cross-byte stitch — scalar, but cheap; the 4-bit one
  (`tbq4_get_code_cuda`) is a nibble select. The WHT inner loop has a hard
  sequential dep across stages (can't `float4` it without per-stage
  barriers). Both fine once the redundancy is gone.
- **Warp reductions / occupancy:** no reductions in the decode itself; the
  flash-attn KQ accumulation reduction lives in `fattn-vec.cuh` and is the
  standard `__shfl` tree. Occupancy: `__launch_bounds__(128,1)` is already set
  in `flash_attn_ext_vec`; the `float[32]` per-thread temp is the spill risk.
- **Blackwell:** vec kernel; same story as #1.
- **Benefit: HIGH / Effort: med** — decode-once-into-shared for the TBQ KV
  types in `fattn-common.cuh`. This is #1 on the list.

### 3. `polarquant.cu` — Q4_POLAR weight dequant / `mul_mat` (× Q8_0) / `get_rows`
- **Block geometry:** one CUDA block per 128-element polar block, 128 threads.
  Steps 1–2 (4-bit nibble unpack → centroid LUT) **are** parallel across 64
  threads (`tid < 64`, 2 elems each) and write into `__shared__ buf[128]` —
  good, vectorized-ish. Then **steps 3 (QJL residual), 4 (size-128
  Walsh-Hadamard), 5 (1/128 scale) all run on `tid==0` only** — a serial
  ~448-op WHT tail (7 stages × 64 butterflies) plus, if `use_qjl`, a 128-iter
  loop that *re-runs an `xorshift32` from index 0 for every element*
  (`polar_qjl_sign_cuda(i)` is O(i), so the whole thing is O(128²) ≈ 16k
  iterations). With QJL on, that single-thread tail dominates the kernel.
  (`use_qjl` is gated off by a runtime flag per the header — but if it's ever
  turned on, this is quadratic.)
- **Centroid LUT:** `k_polar_q4_centroids_cuda[16]` in `__constant__` — yes,
  correct. The hot lookup is `buf[2*tid] = centroids[lo]; buf[2*tid+1] = centroids[hi]` —
  uniform-ish addressing within a warp, fine.
- **`mul_mat` path:** grid `(nrows_x, nrows_y)` — one block per output
  element, `n_per_row/128` polar blocks walked in a loop, each doing the full
  unpack→WHT→scale into `buf[]` then a per-thread `acc += l2·buf[tid]·q8scale·q8`
  with a `__syncthreads()` *per polar block*. Same pattern as `turbo-tcq.cu`:
  GEMV-with-decode, no output tiling, no MMA. The decode (esp. the
  single-thread WHT) is now *serialized inside the K-loop*, so a long row =
  `n_rows · serial_WHT` — this is the slow part of `mul_mat` for big tiers.
- **Loads/stores:** `src->qs[tid]` is a byte read (not `int4`); `dst` write at
  the end is one scalar per thread (`y[b*128 + tid]`), not coalesced into
  `float4`. The `__half2float(src->d)` is a single fp16→fp32. Minor.
- **`get_rows`:** correct structure (one block per `(selected_row, polar_block)`),
  but inherits the same single-thread WHT tail.
- **Fusion:** the `mul_mat` *does* fuse dequant into the dot. But the
  GGUF/converter side **doesn't emit Q4_POLAR yet** (`gguf_eliza1_apply.py`
  falls back to Q8_0), so on real inference today this kernel is **not
  exercised** — the model runs Q8_0 through cuBLAS. That's the #2 punch-list
  item: it's not a kernel perf bug, it's "the kernel exists and the converter
  doesn't feed it."
- **Big structural gap:** there is **no flash-attn integration** for Q4_POLAR
  and **no fattn-vec instance** — Q4_POLAR is purely a weight type. (That's
  arguably correct; weights go through `mul_mat`, not flash-attn.) But the
  `mul_mat_q4_polar_q8_0` kernel is the only matmul path, and it's a
  hand-rolled GEMV — for prefill on a 4B/9B/27B tier you want a real
  dequant→shared-tile→`wgmma`/`tcgen05` MMA, not 128 threads doing one dot
  with a serial WHT in the inner loop.
- **Blackwell:** strong opportunity here — Q4_POLAR-weight-dequant-into-MMA is
  exactly the kind of thing `tcgen05` (and FP4 on Blackwell) is built for, but
  the current kernel is not structured to take an MMA tile; it's a per-output
  GEMV. Rewrite-level effort.
- **Benefit: HIGH (once the converter emits Q4_POLAR) / Effort: high** for an
  MMA-tile `mul_mat`; **Benefit: med / Effort: low** for parallelizing the
  WHT tail across the 128 threads it already has (7 stages with a
  `__syncthreads` per stage is *cheaper* than 448 serial ops on one thread)
  and fixing the O(128²) QJL-sign loop (precompute the 128-sign vector once
  into shared, or just iterate the xorshift forward once).

### 4. `qjl.cu` — QJL 1-bit packed-K quantize / dequantize / attention-score
- **Block geometry:** quantize = one block per row, **256 threads** (one per
  sketch dim); each thread does a 128-term inner product `s_key[i]·prj[i·256+j]`
  with `s_key` staged in `__shared__` (`#pragma unroll`) — good, the key is
  loaded once. Sign packing uses `__ballot_sync` per warp → lane 0 writes 4
  bytes — clean, no atomics, correct LSB-first layout. `||k||₂` via warp-shfl
  reduce + 8-element `s_partial[]` — standard.
- **dequantize:** one block per row, 128 threads (one per head_dim slot), each
  thread runs the 256-term `sum_j sign·prj_row[j]` (`#pragma unroll 8`),
  signs staged in `__shared__ s_signs[32]`. Correct. The `prj` matrix is read
  from global with stride `i·256+j` — that's `head_dim`-strided columns,
  *not* coalesced across threads (thread `i` reads `prj[i·256 + j]`,
  consecutive threads are 256 floats = 1 KB apart). The projection matrix is
  reused across every row/token so it's L2-resident, but a transposed `prj`
  layout (`prj[j·128 + i]`) would make the dequant loads coalesced. Medium.
- **score kernel:** grid `(n_heads, n_kv_tokens)`, **32 threads** (one warp,
  one sign-byte each), `#pragma unroll` 8-wide, then a warp-shfl reduce — a
  perfect 1-warp fit, very tight. But: **one block per `(head, token)` pair**
  with only 32 threads means tiny blocks and a *huge* grid for long context
  (`n_heads · n_kv_tokens` blocks) — launch overhead and poor SM packing.
  Better: one block per `(head, token-tile)` with 256 threads handling 8
  tokens, or fuse the score into the flash-attn loop.
- **Fusion — the big gap:** QJL is a **separate pass**, not fused into
  flash-attention. The pipeline is: project Q → `q_sketch`; `qjl_score_kernel`
  → `scores[n_heads, n_kv_tokens]` in global; then a *separate* softmax + a
  *separate* `V` aggregation. That materializes the full `n_heads × n_kv`
  score matrix in HBM — exactly what flash-attention exists to avoid. A fused
  `flash_attn_ext_vec`-style kernel that does the JL-projected score, online
  softmax, and V-accumulation in one pass over the KV blocks (the way the
  `tbq3_0`/`tbq4_0` fattn-vec instances do for those KV types) would be a real
  `tg` *and* memory win at long context. **This is the #3 item.**
- **Vectorization:** `prj` reads are scalar fp32; the sign bytes are byte
  reads. No `float4`. The inner products are the bulk of the work and they're
  fp32 MACs — fine for accuracy, but a half-precision sketch + fp16 `prj`
  would halve the bandwidth on the (bandwidth-bound) dequant.
- **Blackwell:** vec/scalar kernel; the score inner product (`q_sketch · signs`)
  is a structured ±1 dot that doesn't map to a tensor-core MMA cleanly (the
  signs are bits, not a quantized matrix the MMA hardware understands). Low
  Blackwell leverage; the win here is *fusion*, not tensor cores.
- **Benefit: HIGH / Effort: high** — a fused QJL flash-attn kernel.
  **Benefit: med / Effort: low** — bigger blocks in `qjl_score_kernel`
  (token-tiling) and a coalesced/transposed `prj` layout for dequant.

### 5. The `tbq3_0` / `tbq4_0` fattn-vec instances + `fattn-vec.cuh` integration
- **Structure:** `template-instances/fattn-vec-instance-tbq{3,4}_0-tbq{3,4}_0.cu`
  are 3-line `DECL_FATTN_VEC_CASE(D, ...)` stamps for D∈{64,128,256} — same
  machinery as the stock `q4_0`/`q8_0` fattn-vec instances. The K-side
  `nthreads_KQ` is set to `128/cpy_nb` for TBQ (same as F16, not the `q8_1`
  path) and `Q_q8_1=false` — so TBQ K is *not* requantized to q8_1 the way
  q4_0/q8_0 K is; it's decoded straight to fp16/fp32. That's the right call
  for a KV type (the K is already a fresh decode each step). The V-side uses
  `dequantize_V_tbq*`. CUDA-graph capture and split-K work because it's the
  standard vec-FA kernel.
- **Issue:** see #2 — the per-thread redundant `tbq_decode_block_cuda` is
  inside *this* path. Fixing it touches `fattn-common.cuh`
  (`vec_dot_fattn_vec_KQ_tbq` / `dequantize_V_tbq`), not the instance stamps.
- **Missing instances:** there is no `f16-tbq{3,4}_0` or `tbq*-f16` mixed
  instance (only the four `tbq×tbq` combos), and **no `qjl1_256` or
  `q4_polar` fattn-vec instances at all** — so a K=QJL / V=TBQ config (the one
  `THROUGHPUT.md` and `qjl_config.json` actually describe for long context:
  `--cache-type-k qjl1_256 --cache-type-v tbq3_0`) **has no fused flash-attn
  kernel** and must fall back to the unfused QJL score-pass + a separate V
  path. That's the same gap as #4, viewed from the instance side.
- **Benefit: HIGH / Effort: med–high** — add the `qjl1_256`-K fattn-vec
  instance(s) (which requires the fused QJL score logic from #4) and the
  mixed `f16`/`tbq` combos that real configs need.

---

## Top-5 highest-leverage items (for the inference team)

1. **Decode-once-into-shared for the TBQ3_0/TBQ4_0 KV types in flash-attn.**
   `fattn-common.cuh::vec_dot_fattn_vec_KQ_tbq` / `dequantize_V_tbq` currently
   run a full 32-element Walsh-Hadamard + sign-flip *per thread*, recomputing
   each K/V sub-block ~8–16× and putting a `float[32]` temp in registers.
   Stage the decoded sub-block in shared once per CUDA block (one warp does
   the WHT) like the F16 path. **Benefit: HIGH / Effort: med.** Biggest single
   kernel win; directly speeds `tg` for any long-context run using the fork's
   KV quant.

2. **Wire Q4_POLAR through the GGUF converter so `mul_mat_q4_polar_q8_0` is
   actually used** — the CUDA kernel exists and fuses dequant into the dot, but
   `gguf_eliza1_apply.py` falls back to Q8_0 because the fork's
   `convert_hf_to_gguf.py` + `gguf-py` don't emit `q4_polar`. This is the
   single biggest *unrealized* inference memory/`tg` win for the 4B/9B/27B
   tiers (4.25 bpw vs 8). Converter work, not kernel work. **Benefit: HIGH /
   Effort: med** (converter side; the runtime kernel is done).

3. **A fused QJL flash-attention kernel** (and the `qjl1_256`-K fattn-vec
   instance). Today QJL is a separate `qjl_score_kernel` that materializes the
   full `n_heads × n_kv` score matrix in HBM, then a separate softmax + V
   aggregation — i.e. it defeats the point of flash-attention at exactly the
   long-context regime where QJL is supposed to help. Fold the JL-projected
   score, online softmax, and V-accumulate into one pass over the KV blocks,
   the way the `tbq×tbq` fattn-vec instances do for those types. **Benefit:
   HIGH / Effort: high.**

4. **Parallelize the Q4_POLAR Walsh-Hadamard tail and de-quadratic the QJL
   residual.** `polar_dequantize_kernel` / `polar_mul_mat_q4_polar_q8_0_kernel`
   do the size-128 WHT + 1/128 scale on `tid==0` only (448 serial ops), and
   `polar_qjl_sign_cuda(i)` is O(i) so the QJL-residual loop is O(128²) when
   enabled. Use the 128 threads the kernel already launches (7 WHT stages with
   a `__syncthreads` per stage beats 448 serial ops); precompute the 128-sign
   vector once into shared. **Benefit: med / Effort: low.** Cheap, isolated,
   matters most for the `mul_mat` path on big tiers (the WHT is in the K-loop).

5. **Native sm_120 build + an MMA-tile prefill path for the custom weight
   matmuls.** The fork builds `89/90` PTX → JIT to sm_120 (works, no `tcgen05`
   / FP4). For prefill (`pp`, compute-bound) the `mul_mat_q4_polar_q8_0` and
   `mul_mat_tbq3_tcq_q8_0` kernels are hand-rolled GEMVs (one block per output
   element, no output tiling, decode in the inner loop) — they should be
   dequant-into-shared-tile + `wgmma`/`tcgen05` MMA. Step 1: add a
   `CMAKE_CUDA_ARCHITECTURES=120` build once a CUDA-12.8+ toolkit is on the
   box (the system nvcc is 12.0 today — blocker). Step 2: the MMA-tile rewrite.
   **Benefit: med (pp only; tg is decode/bandwidth-bound and won't move) /
   Effort: high.**
