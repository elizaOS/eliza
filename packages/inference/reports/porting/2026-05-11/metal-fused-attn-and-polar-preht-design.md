# Metal design: `GGML_OP_FUSED_ATTN_QJL_TBQ` + `kernel_attn_score_q4_polar_preht_f32`

Status: **design only.** No Apple hardware on the authoring machine — nothing here is
benchmarked or verified. Every claim below is from static review of
`packages/inference/metal/*.metal`, the C references in
`packages/inference/reference/turbo_kernels.c` + `verify/qjl_polar_ref.c`, the CUDA
originals, and the patcher in `packages/app-core/scripts/kernel-patches/metal-kernels.mjs`.
An M-series agent must run `make -C packages/inference/verify metal-verify` (+ the new
fused/preht fixtures) before flipping any verification-matrix row.

This doc covers two distinct things:

1. **`kernel_attn_score_q4_polar_preht_f32`** — a *score-only* Polar kernel against a
   pre-Hadamarded query. Small, low-risk, mostly already prototyped as
   `kernel_mul_mv_q4_polar_preht_f32`. The work here is renaming/aligning it to the
   attention-score ABI (q_head / n_kv / head_offset semantics), adding the manifest
   `q-is-pre-Hadamarded` bit, and a fixture.
2. **`GGML_OP_FUSED_ATTN_QJL_TBQ`** — the big one. K-score (QJL or Turbo or Polar) →
   online softmax over KV pages → V-mix (Turbo/Polar V-cache) → output, all in one
   kernel, tiled so the running softmax max/sum cancel within a tile rather than after
   a full materialized score vector. Needs a fused-attention C reference + fixture from
   the fused-attention-reference agent before any Metal port.

---

## Part 0 — context: what exists and what the perf data actually says

Standalone Metal kernels (all 8/8 PASS on M4 Max per README; verification ran via
`MTLDevice.newLibraryWithSource`):

- `kernel_turbo3_dot` / `_multi`, `kernel_turbo4_dot` / `_multi`,
  `kernel_turbo3_tcq_dot` / `_multi` — Q·K score, four 32-elem records → 128-wide row.
  TBQ3 = `half norm; uint8 qs[8]; uint8 signs[4]` (14 B, ×4 = 56 B/row).
  TBQ4 = `half norm; uint8 qs[16]` (18 B, ×4 = 72 B/row).
  TBQ3_TCQ = `half norm; uint8 qs[49]; uint8 pad` (52 B/row, 1 record).
- `kernel_attn_score_qjl1_256` / `_multi`, `kernel_get_rows_qjl1_256`,
  `kernel_mul_mv_qjl1_256_f32` — QJL K-score. Block `uint8 qs[32]; ushort norm_bf16`
  (34 B). Consumes a pre-projected `q_sketch` (n_heads × 256 fp32).
- `kernel_get_rows_q4_polar`, `kernel_mul_mv_q4_polar_f32`,
  `kernel_mul_mv_q4_polar_preht_f32` — Polar V-cache decode + dot. Block
  `half d; uint8 qs[64]; uint8 qjl[16]` (82 B), 128-elem block. Decode = LUT lookup →
  optional 1-bit QJL residual → 7-stage in-place Walsh-Hadamard → `×(1/128)` →
  `×fp16-norm`.

Bench sanity check (M4 Max, single decode-step scoring, head_dim=128, seq=4096,
n_kv_heads=32, 9B-class buffers):

- The four small kernels (`turbo3/turbo4/turbo3_tcq/qjl`) all sit at ~228–270 µs GPU
  median **regardless of buffer size or batch size**. `bench_M4Max_2026-05-10.md` first
  called this a launch-tax floor; `bench_M4Max_batched_2026-05-10.md` then showed
  batching N dispatches into one command buffer drops total cost roughly *linearly* with
  N — so it is **not** a launch floor, it is the kernel hitting its own (low, ~5–7% of
  peak) realized bandwidth. The `_multi` variants do better (turbo3 N=8 ≈ 51 µs,
  turbo4 N=32 ≈ 69 µs, turbo3_tcq N=4 ≈ 106 µs, qjl N=8 ≈ 55 µs) because each
  threadgroup serially reuses its bound buffers across N blocks — fewer threadgroups,
  same total memory traffic, less scheduling overhead per byte. Past N≈8 the small
  kernels regress (turbo4 is the exception out to N≈32) as the serial loop starves the
  GPU. **The `_multi` numbers and the family-specific N table (turbo3=8, turbo4=32,
  turbo3_tcq=4) in `metal-kernels.mjs:1163` are internally consistent with the bench
  JSONs and the multi-block report.**
- Polar was the outlier at ~4216–5727 µs (Wave-5 baseline) because the 128-elem
  7-stage Walsh-Hadamard butterfly ran entirely on `tid==0` with 31 lanes idle. The
  Wave-3/4-B cooperative-butterfly fix (`polar_hadamard_inplace_tg32`, 32 lanes ×
  2 of 64 pairs/stage) brought it to ~458–586 µs. The pre-Hadamard-query variant
  (`kernel_mul_mv_q4_polar_preht_f32`) drops it further to ~285 µs by eliminating the
  per-K-row butterfly entirely (`dot(Hx, q) == dot(x, Hq)`; H is symmetric).
  **The "~650 µs Polar slowest Metal kernel" framing in the task prompt is roughly the
  cooperative-butterfly number; the pre-Hadamard variant is the fix and the ~285 µs
  figure is what to design around.** There is a residual cosmetic inconsistency across
  docs (5726 vs 5727 vs 4216 µs as the "before", 458 vs 586 µs cooperative, 285 vs 288
  pre-Hadamard) — all are short-run M4 Max medians at different iter counts; treat the
  *relative* speedups (≈12.5× cooperative, ≈2× more for pre-Hadamard) as the durable
  claim.

**Voice-mode policy consistency:** `bench_M4Max_batched_2026-05-10.md` shows barge-in
cancellation = wait-for-in-flight-command-buffer-to-drain, and at N≥4 worst-case
cancellation is 0.8–1.4 ms (small kernels) up to ~138 ms (polar at N=128) — past the
voice loop's ≤1-tick (~250 µs) goal. So **voice mode must use N=1 and must not use
command-buffer batching**, which is exactly what the kernel-optimization review and the
remaining-work ledger say. The fused-attn kernel below inherits this: it must tile for
cancellation, not just throughput, so a voice forward pass can be cancelled at a tile
boundary, not only at the end of a 256k-token scan.

The patcher does **not** currently know whether a graph was launched by voice mode — it
hard-codes the throughput-optimal N table. The voice/non-voice override is a
higher-scheduler-layer concern (out of scope for this doc, flagged in the ledger). The
fused-attn op should expose its tile size as a graph op-param so the scheduler can pass
a small tile for voice and a large one for bulk prefill.

---

## Part 1 — `kernel_attn_score_q4_polar_preht_f32`

### Why

`kernel_mul_mv_q4_polar_f32` and `kernel_get_rows_q4_polar` both materialize a 128-float
decoded block into `threadgroup` scratch, run the 7-stage Hadamard, then dot/copy. In
the attention-score hot path the query vector is reused across many K rows, so the
Hadamard belongs on the query, once, not on every K row. `kernel_mul_mv_q4_polar_preht_f32`
already does this — but it has a `polar_mv_args { n_rows; head_dim; use_qjl }` ABI and a
one-threadgroup-per-row dispatch, which is the mat-vec shape, not the attention-score
shape that `kernel_turbo*_dot` / `kernel_attn_score_qjl1_256` use (q_head index,
n_kv, head_offset_bytes, scores written as `[q_head * n_kv + kv]`). The new kernel is
that same algebra exposed with the attention-score ABI + the `_multi` launch-tax fix.

### Kernel: `kernel_attn_score_q4_polar_preht_f32`

```metal
struct polar_score_args {
    uint head_dim;          // must equal 128
    uint n_kv;              // number of Polar V-blocks (one per token) for this head
    uint kv_stride_blocks;  // 1 for head_dim=128 (one 128-elem block per token)
    uint q_head;            // which query head's pre-Hadamarded row to read
    uint head_offset_bytes; // byte offset into k_blocks for this KV head; multiple of 82
    uint use_qjl;           // 0 / 1 — whether the block's qjl[] residual is meaningful
};

kernel void kernel_attn_score_q4_polar_preht_f32(
        device const float          * q_preht  [[buffer(0)]],  // (n_heads, head_dim) fp32 = H*q
        device const block_q4_polar  * k_blocks [[buffer(1)]],  // (n_kv_heads, n_kv) row-major
        device       float           * scores   [[buffer(2)]],  // (n_heads, n_kv) fp32
        constant     polar_score_args & args    [[buffer(3)]],
        uint                            tid      [[thread_position_in_threadgroup]],
        uint                            kv_idx   [[threadgroup_position_in_grid]]) {
    if (kv_idx >= args.n_kv || args.head_dim != QK_POLAR) return;
    device const block_q4_polar * blk =
        (device const block_q4_polar *)((device const uchar *)k_blocks + args.head_offset_bytes)
        + kv_idx * args.kv_stride_blocks;
    device const float * qp = q_preht + args.q_head * QK_POLAR;

    // 32 lanes × 2 bytes (= 4 centroid codes) each. fp32 accumulate.
    float acc = 0.0f;
    for (uint b = tid; b < QK_POLAR / 2; b += 32u) {
        uint8_t byte = blk->qs[b];
        uint i0 = 2u * b, i1 = i0 + 1u;
        float x0 = POLAR_Q4_CENTROIDS[byte & 0xFu];
        float x1 = POLAR_Q4_CENTROIDS[(byte >> 4) & 0xFu];
        if (args.use_qjl != 0u) {
            float scaled = ((blk->qjl[0] & 1u) ? 1.0f : -1.0f)
                         * POLAR_QJL_CORRECTION_MAGNITUDE * POLAR_QJL_INV_SQRT_QK;
            x0 += scaled * POLAR_QJL_SIGNS[i0];
            x1 += scaled * POLAR_QJL_SIGNS[i1];
        }
        acc = fma(x0, qp[i0], acc);
        acc = fma(x1, qp[i1], acc);
    }
    float sum = simd_sum(acc);              // threadgroup == one 32-lane SIMD-group
    if (tid == 0) scores[args.q_head * args.n_kv + kv_idx] = sum * float(blk->d) * POLAR_INV_QK;
}
```

Plus `kernel_attn_score_q4_polar_preht_f32_multi` with `blocks_per_threadgroup` in the
args struct and a serial outer loop over `kv_base + b`, exactly mirroring
`kernel_turbo3_dot_multi`. Default N to be learned on hardware; start with the same
sweep as turbo3 ({2,4,8,16}).

### Numeric identity to keep bit-stable

This kernel must produce the same scalar as `eliza_polar_mul_mv` (reference) /
`kernel_mul_mv_q4_polar_f32` to within the 1e-3 fixture tolerance, using the identity
`<dequant(blk), q> = <H·(centroids+residual)/128·norm, q> = <(centroids+residual), H·q>·norm/128`
(H symmetric, applied with the unnormalized 128-point Walsh-Hadamard convention the
decoder uses — same as `hadamard128_inplace` in `metal_verify.mm`). The `×norm/128`
scalar is applied once after `simd_sum`. Do **not** fold the residual into the LUT, do
**not** change the centroid constants, do **not** reorder the FMA chain across the
`use_qjl` branch in a way that changes the per-lane partial — keep it lane-local then
`simd_sum`, matching the existing preht kernel.

### The `q-is-pre-Hadamarded` manifest bit

The decoded-K dot kernels accept raw `q`; this kernel requires `H·q`. They are not
interchangeable. Add a kernel-capability flag so the runtime hard-fails on a mismatch
instead of silently producing wrong scores:

- **Manifest** (`eliza-1.manifest.json`, `kernels` block): add an optional
  `polar_q_pretransform` field, value `"hadamard128"` (the only supported convention) or
  absent. A bundle whose Polar V-mix path is wired through the preht kernel sets it; a
  bundle using the decode-then-dot path does not. The runtime, on activation, checks the
  field against the kernel set it actually loaded and refuses to activate on mismatch
  (AGENTS.md §3/§6: capability mismatch is a hard error, no fallback).
- **`CAPABILITIES.json`** (build output, written by `build-llama-cpp-dflash.mjs` from
  `verify/metal-runtime-dispatch-evidence.json`): add `polar_preht: true` only when both
  the `kernel_attn_score_q4_polar_preht_f32` symbol is present in `default.metallib`
  *and* the dispatch-smoke evidence shows the `GGML_OP_ATTN_SCORE_POLAR` route taking the
  preht path numerically matches the reference (with `H·q` pretransform applied by the
  graph). Symbol presence alone does not flip it (same gating as today's `qjl_full`).
- **Graph op-param**: `GGML_OP_ATTN_SCORE_POLAR` already carries `use_qjl` in op_params;
  add a second int param `q_pretransformed` (0/1). The Metal dispatcher
  (`patchTbqPolarAttnDispatch` in `metal-kernels.mjs`) selects
  `kernel_mul_mv_q4_polar_f32` when 0 and `kernel_attn_score_q4_polar_preht_f32` (or its
  `_multi`) when 1, and `GGML_ASSERT`s that the upstream node actually pre-transformed Q
  (a tiny `GGML_OP_HADAMARD128` or a fused step in the QKV projection — owned by the
  graph-builder agent, not this doc). Do not let the dispatcher pick the preht kernel
  unless the param says Q was transformed.

### Verification plan (M-series agent)

1. Reuse `fixtures/polar.json` + `fixtures/polar_qjl.json`. `metal_verify.mm` already
   special-cases `preht` kernels: it applies `hadamard128_inplace` to the fixture `q`
   before binding (line 358). Extend the harness's polar branch so a kernel whose name
   ends `_preht_f32` and lives in the *attention-score* family (n_kv / q_head ABI rather
   than n_rows) is dispatched with `polar_score_args` and the `[q_head*n_kv+kv]` output
   layout. (Today the polar branch always uses `PolarMvArgs` + `[row]` layout — fine for
   the existing `mul_mv_*_preht`, needs a tiny widening for the score-ABI variant.)
2. `make -C packages/inference/verify metal-verify`: expect 8/8 PASS for
   `kernel_attn_score_q4_polar_preht_f32` against both fixtures (use_qjl 0 and 1),
   max diff in the same ~7e-6 band as the existing preht kernel.
3. `make -C packages/inference/verify metal-verify-multiblock` against the `_multi`
   variant at N ∈ {2,3,4,8} including a non-divisor N.
4. `make -C packages/inference/verify dispatch-smoke` once the graph op-param + Q
   pretransform node are wired: the `GGML_OP_ATTN_SCORE_POLAR` route with
   `q_pretransformed=1` must match `eliza_polar_mul_mv` to 1e-3.
5. `./metal_bench --iters 200 --warmup 20` to record the standalone median; expect it in
   the ~285 µs cluster, in line with the existing `mul_mv_*_preht` measurement.

---

## Part 2 — `GGML_OP_FUSED_ATTN_QJL_TBQ`

### Why fuse

Today's path for one attention layer at decode/prefill:

1. K-score kernel reads the whole packed K-cache, writes `scores[h, t]` to global memory.
2. Softmax kernel reads `scores`, writes normalized weights.
3. V-mix kernel reads the packed V-cache *and* the weights, writes the per-head output.

That is 3 dispatch boundaries, one full score-vector write + read, and the K-cache and
V-cache each streamed once with nothing reused across the steps. The CPU fork already has
`GGML_OP_FUSED_ATTN_QJL_TBQ` (per the remaining-work ledger §"Performance Work Still Worth
Doing" #1) — the GPU ports are the open work. A fused kernel:

- never materializes the full score vector — online (flash-attention-style) softmax keeps
  a running max `m` and running sum `l` per (head, query-pos);
- decodes each K block, scores it, updates `(m, l)` and the running output accumulator,
  decodes the matching V block, mixes it in — all while the K/V bytes are hot;
- gives the scheduler **one cancellation boundary per KV tile** instead of per helper
  kernel. Tile size is a graph op-param so voice can pass a small tile.

This is the right shape for the long-context tiers (32k/64k/128k/256k) where the score
vector itself is large and the dispatch count dominates.

### Scope of "QJL_TBQ"

The op name pairs **QJL K-cache** (the K-score side) with a **TurboQuant or Polar
V-cache** (the V-mix side). For the Eliza-1 tiers (AGENTS.md §2): `0_6b` is Turbo Q3 K +
Polar Q4 V (no QJL — context ≤ 8k, QJL only kicks in > 8k); `1_7b` is Turbo Q3/Q4 + QJL K
(V is Polar Q4 where ctx > 8k); `9b`/`27b` are Turbo Q4 + QJL + Polar. So the fused op
needs to cover, on the K side: **QJL** *or* **TBQ3/TBQ4/TBQ3_TCQ**; on the V side:
**Polar Q4** (use_qjl 0/1) *or* **TBQ V** (if the V-cache uses a Turbo format — confirm
with the training side; the manifests above only ever list Polar for V, so v1 of this
kernel can be QJL/Turbo-K → Polar-V and treat Turbo-V as a later addition). Per AGENTS.md
§9 ("zero polymorphism for runtime type branching" / "kernels are a registry, not an
`if`") this should be **separate kernel functions per (K-format, V-format) pair**, not one
kernel with `if (k_type == ...)`. Concretely: `kernel_fused_attn_qjl_polar_f32`,
`kernel_fused_attn_tbq3_polar_f32`, `kernel_fused_attn_tbq4_polar_f32`,
`kernel_fused_attn_tbq3tcq_polar_f32` (+ `use_qjl` on the Polar side handled by a
compile-time-ish branch inside the V decode, which is acceptable because it's a 1-bit
data flag, not a type switch). The dispatcher picks the function by `(k->type, v->type)`.

### Buffer / push layout (per kernel; example: `kernel_fused_attn_qjl_polar_f32`)

```
buffer(0)  device const float          * q_sketch   // (n_q_pos, n_heads, 256) fp32 — QJL-projected Q
                                                     //   (for the Turbo-K variants this is instead
                                                     //    q_preht: (n_q_pos, n_heads, 128) fp32 = FWHT-rotated Q)
buffer(1)  device const block_qjl1_256  * k_packed   // (n_kv_heads, n_kv, block) row-major
buffer(2)  device const block_q4_polar   * v_packed   // (n_kv_heads, n_kv, block) row-major
buffer(3)  device       float            * out        // (n_q_pos, n_heads, 128) fp32 — attention output
buffer(4)  constant     fused_attn_args  & args
```

`fused_attn_args`:

```metal
struct fused_attn_args {
    uint head_dim;        // 128
    uint proj_dim;        // 256 (QJL side; ignored for Turbo-K variants)
    uint n_heads;         // query heads
    uint n_kv_heads;      // GQA: h_kv = h_q / (n_heads / n_kv_heads)
    uint n_q_pos;         // query positions in this dispatch (1 at decode, batch at prefill)
    uint n_kv;            // KV length being attended
    uint kv_tile;         // KV positions per online-softmax tile (op-param; small for voice)
    uint v_use_qjl;       // Polar V residual flag (0/1)
    float scale;          // softmax scale = 1/sqrt(head_dim) (or model-specific)
    uint causal;          // 1 → mask kv > q position
    uint q_pos_base;      // absolute position of q_pos 0 (for causal masking against absolute kv)
};
```

KV-cache score scaling: the QJL K-score formula already bakes `||k|| · sqrt(pi/2)/256`
into the score (see `kernel_attn_score_qjl1_256`), and the Turbo-K dot returns the raw
`Q·K_decoded`. The model's `1/sqrt(d)` softmax scale is `args.scale`, applied to the
score before the `exp`. Keep these two factors separate and explicit — do not pre-multiply
`scale` into the QJL constant, because the Turbo-K and QJL-K variants need different
treatment and conflating them is exactly the kind of hidden-branch the architecture rules
forbid.

### Threadgroup strategy

One threadgroup per `(h_q, q_pos)` — i.e. grid `(n_heads, n_q_pos, 1)`, threadgroup
`(32, 1, 1)` = one Apple SIMD-group (keep the `simd_sum` assumption that every other
shader in this dir relies on; do **not** bump to 64 without switching to a threadgroup
scratch reduction — see the ledger note #4). Per threadgroup:

```
threadgroup float acc_o[128];     // running output accumulator for this (h_q, q_pos)
threadgroup float kdec[128];       // (Turbo-K variants only) decoded K block scratch — QJL needs none
threadgroup float vdec[128];       // decoded V block scratch
float m = -INFINITY;               // running max (per-lane copy, reconciled via simd_max)
float l = 0.0f;                    // running denominator
// zero acc_o cooperatively, barrier
for (uint t0 = 0; t0 < n_kv; t0 += kv_tile) {
  for (uint t = t0; t < min(t0 + kv_tile, n_kv); ++t) {
    if (causal && (q_pos_base + q_pos) < t) continue;        // or break, depending on layout
    // --- K score ---
    //   QJL variant: lane tid owns byte tid of k_packed[h_kv][t].qs, two float4 q_sketch loads
    //     (exactly kernel_attn_score_qjl1_256's inner block), simd_sum → s, then s *= scale.
    //   Turbo variant: cooperatively decode the 4×32 records into kdec[] (or do the lane-local
    //     dot directly like kernel_turbo*_dot — preferred, no scratch), simd_sum → s, s *= scale.
    float s = ... ; s *= args.scale;
    // --- online softmax update (numerically stable) ---
    float m_new = max(m, s);
    float corr  = exp(m - m_new);          // rescale factor for the running state
    float p     = exp(s - m_new);          // this token's unnormalized weight
    l = l * corr + p;
    // --- V decode + mix ---
    //   Polar V: cooperatively LUT-unpack v_packed[h_kv][t].qs into vdec[], apply optional
    //   qjl residual, run polar_hadamard_inplace_tg32(vdec, tid), then each lane does
    //   acc_o[i] = acc_o[i] * corr + p * vdec[i] * (float(v.d) * POLAR_INV_QK)  for its 4 indices.
    //   (Fold the per-block (d/128) into p once, not per element, if it stays bit-stable.)
    m = m_new;
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }
  // (no cross-tile barrier needed beyond the per-token one; the tile loop is just for the
  //  scheduler's cancellation granularity — a cancelled dispatch loses the in-flight tile only.)
}
// finalize: out[q_pos, h_q, i] = acc_o[i] / l   (cooperative, l broadcast via simd_*; guard l>0)
```

Notes that matter for correctness/cancellation:

- The online-softmax recurrence (`m`, `l`, `acc_o` rescaled by `exp(m_old - m_new)`) is
  the standard flash-attention identity; it produces the exact same result as
  materialize-scores → max → exp → sum → weighted-V to within fp32 rounding. The
  reference for the fixture must be `dequant-K · q → scale → softmax → dequant-V mix`
  using the same `exp`/accumulation order, owned by the fused-attention-reference agent.
- `acc_o[]` and `vdec[]` are `threadgroup`, so the *only* per-tile state that survives a
  cancellation is what's already in `out[]` — which is nothing until the finalize step.
  That means **a cancelled fused-attn dispatch must be re-run from scratch**, not
  resumed. That's fine for voice (the whole point of a small `kv_tile` is the dispatch is
  short) but it means the scheduler must treat the fused op as all-or-nothing per
  `(h_q, q_pos)`. Document this in the op contract.
- `kv_tile` is a graph op-param. Voice: small (e.g. 32–64) so the command buffer for one
  layer's attention is ≤ a few hundred µs and barge-in cancels at the next buffer. Bulk
  prefill/eval: large (e.g. 512–2048) for throughput. Default in the dispatcher: a small
  value; the scheduler raises it for non-voice graphs (same pattern as the multi-block N
  override the ledger asks for).
- Causal masking: at decode `n_q_pos == 1` and every kv ≤ the current pos, so the mask is
  a no-op; at prefill it matters. Use `q_pos_base` to compare against absolute kv index.
- GQA: `h_kv = h_q / (n_heads / n_kv_heads)`, exactly as in the QJL/Turbo score kernels.

### Why this is "tiled for cancellation, not just throughput"

A pure throughput design would do one threadgroup over the *whole* KV range with the
largest possible inner unrolling and never check a tile boundary — minimal overhead, but a
256k-token decode step's attention becomes one un-cancellable command buffer of many ms.
By making `kv_tile` explicit and keeping the per-tile state in threadgroup memory (so
cancelling = losing only the current tile's work), voice can pick a tile that bounds the
command buffer to ≈one tick while bulk work picks a big one. The kernel body is identical;
only the op-param changes.

### Buffer-size / bandwidth note

The fused kernel reads each K block (34 B for QJL) and each V block (82 B for Polar) once
and never writes/re-reads a score vector. For 64k context × 32 KV heads × 80 layers that's
~9.1 GB of KV total (per `bench_M4Max_2026-05-10.md`'s "QJL K + Polar Q4 V" row) vs. the
current path which additionally writes+reads ~`n_heads × n_kv × 4 B` of scores per layer
(at 64k × 32 heads that's ~8 MB/layer/direction, ~640 MB round-trip across 80 layers per
decode step). Eliminating that is the headline win; the dispatch-count reduction (3→1 per
layer) is the secondary win. **No bench number can be claimed until an M-series agent runs
`metal_bench` with a fused-attn mode** — this is a static estimate from the byte counts.

### Verification plan (M-series agent)

1. **Reference + fixtures first** (owned by the fused-attention-reference agent, blocking
   this work): a C reference `eliza_fused_attn_qjl_polar` (and the Turbo-K variants) in
   `verify/` or `reference/` that does `decode-K · q → ×scale → softmax → decode-V mix →
   /sum`, plus JSON fixtures (`fused_attn_qjl_polar.json`, `..._tbq3_polar.json`, etc.)
   with small dims (e.g. n_heads=4, n_kv_heads=2, n_kv=8, head_dim=128, both `use_qjl`
   and both `causal` values), generated by `gen_fixture`. The reference must match the
   existing standalone kernels' scalars when run as score-only (internal consistency
   check, same pattern as `gen_fixture --self-test`'s QJL/Polar parity checks).
2. Extend `metal_verify.mm` with a `fused_attn` fixture branch: bind q_sketch/q_preht,
   k_packed, v_packed, out, `fused_attn_args`; dispatch `(n_heads, n_q_pos, 1)` ×
   `(32,1,1)`; compare the `(n_q_pos × n_heads × 128)` output against
   `expected_output[]` at 1e-3. (The current harness only handles scalar-score outputs;
   this needs a vector-output compare path.)
3. `make -C packages/inference/verify metal-verify` → expect 8/8-style PASS per fused
   variant per fixture. Realistic max-diff band: looser than the score kernels because
   `exp`/division compound — target ≤ 1e-4 absolute on the normalized output, but the
   reference and kernel must use the same accumulation order so the drift stays in the
   1e-5–1e-4 range; if it's worse, the order diverged.
4. `make -C packages/inference/verify dispatch-smoke` once `GGML_OP_FUSED_ATTN_QJL_TBQ`
   graph dispatch is wired in `metal-kernels.mjs` (a new `patchFusedAttnDispatch` sibling
   of `patchTbqPolarAttnDispatch`): a real GGML graph with the fused op must select the
   shipped Metal function and match the reference end-to-end. Only then may
   `CAPABILITIES.json.fused_attn` flip true (symbol presence is not enough — same gate as
   `qjl_full`).
5. `./metal_bench --mode fused` (new mode): record GPU median at 4k/32k/64k/128k/256k
   context and confirm it beats the sum of the three current dispatches at each. The
   acceptance bar from the kernel-optimization review is "lower total graph time than the
   current multi-kernel path at every context, voice still cancellable at a tile."
6. Re-run `make -C packages/inference/verify metal-verify metal-verify-multiblock` to
   confirm the existing standalone kernels still pass (the fused work is additive; the
   standalones stay as the verification + fallback path per AGENTS.md §3).

### Patcher / shipping changes

- `METAL_KERNEL_FILES` in `metal-kernels.mjs` gains a `fused_attn.metal` standalone (one
  file holding `kernel_fused_attn_qjl_polar_f32`, `..._tbq3_polar_f32`,
  `..._tbq4_polar_f32`, `..._tbq3tcq_polar_f32`). It's copied verbatim into
  `ggml/src/ggml-metal/milady-shipped/` with the `// # MILADY-KERNEL-PATCH-V1` sentinel,
  compiled to its own `.air`, and merged into `default.metallib` — same flow as the five
  existing standalones (no change to the CMake patch shape; just one more file in the
  list, which the existing `miladyAirLinesForSdk` / `miladyAirInputs` loops already
  handle).
- iOS `GGML_METAL_EMBED_LIBRARY=ON` path: the patcher's embed branch
  (`patchMetallibCmake` → `SENTINEL_EMBED`) already compiles every `milady-shipped/*.metal`
  to a separate `.air`, merges them with `ggml-metal-embed.air` into a binary
  `default.metallib`, and `.incbin`s the bytes — so a new standalone is picked up
  automatically. No new iOS-specific work beyond making sure the file is in
  `METAL_KERNEL_FILES`. The build gate still refuses an iOS artifact until the fused op is
  *runtime-dispatch-ready* (in `metal-runtime-dispatch-evidence.json`), not merely
  symbol-present — keep that gate.
- New `patchFusedAttnDispatch(cacheDir, {dryRun})` in `metal-kernels.mjs`, sentinel-gated
  (`# MILADY-KERNEL-PATCH-V1` family), wiring `GGML_OP_FUSED_ATTN_QJL_TBQ` in
  `ggml-metal-ops.cpp` to select `kernel_fused_attn_<k>_<v>_f32` by `(src[1]->type,
  src[2]->type)`, with `GGML_ASSERT`s mirroring the existing `ggml_metal_op_attn_score_tbq`
  asserts (head_dim==128, contiguous rows, GQA divisibility, op_param presence). Idempotent
  repair path like `patchTbqPolarAttnDispatch` already has. Hard-fail on an unsupported
  `(k,v)` pair — no generic-op fallback (AGENTS.md §3).
- `kernel-contract.json` / `verify/metal-runtime-dispatch-evidence.json`: add a
  `fused_attn` entry only after step 4 above passes on hardware. `make -C
  packages/inference/verify kernel-contract` keeps the manifest name, capability key,
  fixture set, Makefile target, and dispatch evidence aligned — add the new fused fixtures
  + `metal-verify-fused` target + capability key together so the contract check stays
  green.

---

## Part 3 — items that genuinely need M-series (or other) hardware, ranked

Ranked by how much they block the Eliza-1 publish contract (AGENTS.md §8) vs. how much
they're "nice perf data".

1. **`GGML_OP_FUSED_ATTN_QJL_TBQ` Metal verification + dispatch smoke + bench.** Blocks
   the long-context perf story for the 9b/27b/27b-256k tiers. Needs: the fused-attn C
   reference + fixtures (from the reference agent), a real Apple-Silicon Mac to run
   `metal_verify` (new fused mode), `dispatch-smoke`, and `metal_bench --mode fused` at
   4k…256k. *Cannot be done without Apple hardware and is the single highest-leverage
   open Metal item.*
2. **`kernel_attn_score_q4_polar_preht_f32` (+`_multi`) verification + the `q_pretransformed`
   graph route.** Lower risk than #1 (the algebra is already in `mul_mv_*_preht`), but the
   attention-score-ABI variant, the `_multi` N sweep, the manifest/CAPABILITIES bit, and
   the `GGML_OP_ATTN_SCORE_POLAR` `q_pretransformed=1` route all need an M-series machine
   to verify + dispatch-smoke + bench.
3. **iOS physical-device *bundle* smoke (weight-backed).** The XCFramework symbol/structure
   audit and the bare XCTest runtime-symbol smoke are reportedly green (`ios-physical-device-smoke-latest.json`
   says `status: passed` on iPhone 15 Pro / iOS 26.3.1) — but note the companion
   `ios-physical-device-smoke.md` still says "on-device PASS not claimed", so there is a
   stale-doc inconsistency an iOS-equipped agent should reconcile. The actual P0 blocker
   (remaining-work ledger) is a smoke that loads a real Eliza-1 bundle on the device and
   records first-token / first-audio latency, peak RSS, thermal state. Needs a connected,
   unlocked, Developer-Mode iPhone/iPad + a built XCFramework + a staged bundle.
4. **Apple-Silicon `kv_tile` / `_multi` N retuning on non-M4-Max parts.** The N table
   (turbo3=8, turbo4=32, turbo3_tcq=4) and any fused-attn `kv_tile` defaults were learned
   on an M4 Max (40-core GPU). M1/M2/M3 base/Pro/Ultra and the A-series iPhone/iPad GPUs
   have different core counts and bandwidth; the optimal N/tile will differ. Needs a sweep
   on at least one A-series device and one lower-core M-series part. Perf-only, not a
   correctness gate — but it does affect the iPhone/iPad latency/thermal numbers the
   publish gate records.
5. **Polar pre-Hadamard CPU SIMD variants** (NEON / AVX2 / AVX512-VNNI) and the QJL int8
   sketch path. The scalar references are landed (`ggml_vec_dot_q4_polar_preht_f32_ref`,
   `qjl_score_qk_i8_ref`); the SIMD implementations + per-device latency gates need real
   ARM64 and x86_64 hardware. Out of Metal scope but flagged because the runtime's
   small-device CPU-spill path (>64k context) depends on them being fast enough to hit
   voice latency targets.
6. **Re-confirm the standalone Metal 8/8 after any shader edit.** The README's
   verification matrix shows all five standalones at 8/8 PASS on M4 Max — but if an
   M-series agent lands the Part 1 / Part 2 kernels they must re-run
   `make -C packages/inference/verify metal-verify metal-verify-multiblock` and
   `dispatch-smoke` and only then update the matrix. Do not flip a row to ✓ from a
   compile-clean badge (AGENTS.md §9, CLAUDE.md). This is procedural, not a hardware gap
   per se, but it's the gate that keeps the matrix honest.

---

## Appendix — static review notes on the five existing shaders + `_multi` variants

These are the things I checked against the C references and CUDA originals while writing
the design above. No correctness bug found; one cosmetic-doc inconsistency and one
robustness observation.

- **`turbo3.metal` / `_multi`**: byte layout (`half norm; uint8 qs[8]; uint8 signs[4]`,
  14 B) matches `block_turbo3_0` in the reference and the fork's `dequantize_turbo3_0_t4`.
  Element decode `idx = low2 | (hi1<<2)`, `qs[elem>>2]` (4 elem/byte), `signs[elem>>3]`
  (1 bit/elem), `×norm` — matches. Each lane's 4 elements (`tid*4 .. tid*4+3`) lie wholly
  in one 32-elem block (32 is a multiple of 4 and `tid*4 ∈ {0,4,…,124}`), and share one
  `qs[]` byte and one `signs[]` byte — the hoisting is valid. `kv_stride_blocks=4` ×
  `sizeof(block_turbo3_0)=14` = 56 B/row. The `head_offset_bytes` must be a multiple of
  14 (documented). `float4` query load is 16-byte aligned (`q_base = q_head*128 + tid*4`,
  `tid*4` always a multiple of 4 floats = 16 B). OK.
- **`turbo4.metal` / `_multi`**: `half norm; uint8 qs[16]` (18 B), ×4 = 72 B/row, matches
  the current fork `block_tbq4_0` four-record layout. `qb = qs[elem&15]`,
  `idx = elem<16 ? (qb&0xF) : (qb>>4)`, `×norm` — matches q4_0-style packing. `within0`
  is a multiple of 4 and the `hi = within0>=16` test never straddles the 16 boundary
  (16 is a multiple of 4) — the four `idx*` all use the same nibble half. OK. (The fork's
  in-tree `milady-kernels/tbq4_0.metal` is an earlier draft with a different inner loop;
  the build copies *this* standalone into `milady-shipped/`, so the metallib ships the
  FMA-tuned variant — consistent with `PATCH_AUDIT_2026-05-10.md` and the README.)
- **`turbo3_tcq.metal` / `_multi`**: `half norm; uint8 qs[49]; uint8 pad` (52 B). Decode
  reads a sliding 9-bit window at bit `t*3` (not `t*3 + 6` — the "6 prefix bits" in the
  header comment describe the encoder's framing; the decode in
  `eliza_dequantize_turbo3_tcq_block` reads from bit 0, and the shader's
  `bit_pos0 = tid*12 = (tid*4)*3` matches that). The 24-bit preload (`raw24 = qs[b] |
  qs[b+1]<<8 | qs[b+2]<<16`) covers all four overlapping 9-bit windows of a lane
  (`bit_off0 ≤ 7`, last window at `+9` ⇒ bits 16..24 of the preload, fits in 24). Max
  `byte_idx0 = (31*12)/8 = 46`, `+2 = 48 < 49` — in bounds. Codebook bound at `buffer(3)`
  (512 entries / 2 KB) as `constant float*` — fine, well under Apple's constant-AS cap.
  OK.
- **`qjl.metal` / `_multi` / `kernel_attn_score_qjl1_256_multi`**: `uint8 qs[32]; ushort
  norm_bf16` (34 B). Score = `||k||·sqrt(pi/2)/256·Σ sign(j)·q_sketch[j]` — matches
  `eliza_qjl_score_qk` (`scl_base = 1.2533141373155003f/256`). Lane `tid` owns byte `tid`
  (8 sign bits) and reads `q_sketch[tid*8 .. tid*8+7]` as two `float4`s — `tid*8` is a
  multiple of 8 floats = 32 B, so the `float4*` cast is aligned. Branchless `±1`:
  `((bit<<1)-1)` as float — correct (`bit=0→-1`, `bit=1→+1`). The uniform `uint3`
  attribute params (`tid3`, `tg_pos`) are the Wave-3 fix for Metal's "all-scalar or
  all-same-width-vector" attribute-shape rule; `kernel_attn_score_qjl1_256_multi` has the
  *same* `uint3` shape — consistent. GQA `h_kv = h_q / (n_heads/n_kv_heads)` matches.
  `kernel_get_rows_qjl1_256` (the dequant fallback) and `kernel_mul_mv_qjl1_256_f32`
  (non-attention mat-vec) both match their reference counterparts. OK.
- **`polar.metal`**: `half d; uint8 qs[64]; uint8 qjl[16]` (82 B), 128-elem block.
  Decode = LUT(`POLAR_Q4_CENTROIDS`, 16 entries) → optional 1-bit QJL residual
  (`±1·POLAR_QJL_SIGNS[i]·0.5/sqrt(128)`, the xorshift32(seed=42) sign table inlined as a
  literal — bit-identical to `eliza_polar_qjl_signs`) → 7-stage in-place Walsh-Hadamard
  (`polar_hadamard_inplace_tg32`: 32 lanes × 2 of 64 pairs/stage, one barrier between
  stages — within a stage every index 0..127 is touched by exactly one pair so no race;
  algebraically identical to `eliza_polar_hadamard_inplace`) → `×(1/128)` (the
  butterfly→orthonormal-inverse compensation, folded into the final per-row scalar) →
  `×fp16-norm`. `kernel_mul_mv_q4_polar_f32` and `kernel_get_rows_q4_polar` materialize
  the 128-float block in `threadgroup` scratch; `kernel_mul_mv_q4_polar_preht_f32` skips
  the scratch + butterfly via `dot(Hx,q)=dot(x,Hq)` (H symmetric). All match
  `eliza_polar_dequantize_row` / `eliza_polar_mul_mv`. **Cosmetic-doc note:** the
  "before" Polar µs figure varies across the bench docs (5726 / 5727 / 4216 µs) and the
  "after-cooperative" / "after-preht" figures vary too (458/586, 285/288) — different
  short-run M4 Max medians at different iter counts; harmless but worth a one-line note in
  whichever doc is treated as canonical.
- **Robustness observation (all 32-lane-`simd_sum` shaders, not a bug today):** every
  kernel here is correct *only* while the dispatch threadgroup size is exactly 32 and the
  GPU's SIMD-group width is 32. `metal_verify.mm`, `metal_bench.mm`, and the patcher's
  graph dispatch all use `MTLSizeMake(32,1,1)`, and Apple Silicon guarantees a 32-lane
  SIMD-group — so on the verified targets it's fine. But this is load-bearing and
  undocumented in some of the `_multi` kernels. If anyone ever bumps the threadgroup
  size, *all* of these need the Vulkan-style threadgroup-scratch + barrier reduction, not
  `simd_sum`. The README's "most likely on-hardware failure modes" list already says this;
  keeping it true is the main thing to watch.
- **`metal_verify.mm`**: small fix candidate (not landed — no hardware to verify): the
  `is_polar` branch always binds `PolarMvArgs` and uses the `[row]` output layout. The
  Part-1 attention-score-ABI preht kernel needs `polar_score_args` + `[q_head*n_kv+kv]`.
  When that kernel lands, widen this branch (or add a `is_polar_score` sub-case keyed on
  the fixture having `q_head`/`n_kv` rather than `n_rows`). I did not change it now
  because the change is only meaningful alongside the new kernel and can't be verified
  here.
