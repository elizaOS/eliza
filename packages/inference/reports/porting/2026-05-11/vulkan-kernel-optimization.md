# Vulkan kernel optimization — Intel Arc/Xe (Mesa ANV) — 2026-05-11

Scope: the Vulkan compute shaders under `packages/inference/vulkan/`, the perf
side of the verify harness (`packages/inference/verify/`), and the Vulkan
runtime-dispatch policy in
`packages/app-core/scripts/kernel-patches/vulkan-kernels.mjs`. Hardware: this
machine's Intel Core Ultra 9 275HX iGPU (Arrow Lake / Xe-LPG, Mesa ANV 25.2.8,
Vulkan 1.4.318, `subgroupSize=32`, `timestampPeriod=52.08 ns`,
`maxComputeSharedMemorySize=65536`). No NVIDIA dGPU (D3cold; NVK can't
enumerate it), no Apple/AMD hardware.

## 1. New profiling harness — `vulkan_bench`

Added `packages/inference/verify/vulkan_bench.cpp` + `make vulkan-bench`
(`VULKAN_BENCH_JSON=...` to emit JSON). It is the timing sibling of
`vulkan_verify` (which already covers correctness): `VK_QUERY_TYPE_TIMESTAMP`
around each `vkCmdDispatch` (TOP→BOTTOM of pipe), one warm-up submit then N
measured submits (`--runs`, default 9), median GPU time in µs. It sweeps:

- standalone score kernels `turbo3 / turbo4 / turbo3_tcq` (n_kv) and the
  `_multi` variants over `BLOCKS_PER_WG ∈ {1,2,4,8,16}` (constant_id 0);
- `qjl` / `qjl_multi` over `TOKENS_PER_WG ∈ {1,2,4,8,16}` (n_heads=8, GQA 4);
- `polar` / `polar_preht` (n_rows);
- `fused_attn_qjl_tbq` / `fused_attn_qjl_polar` (n_heads=8, GQA 4);

each at n_kv ∈ {512, 4096, 32768} (the 0.6B/1.7B context tiers). Synthetic
(zeroed) inputs — correctness is `vulkan_verify`'s job, and zeroed K/V scales to
32k without giant fixtures. Refuses software ICDs unless
`ELIZA_ALLOW_SOFTWARE_VULKAN=1`; runs with `MESA_SHADER_CACHE_DISABLE=1` for
clean timings. Raw data: `packages/inference/verify/bench_results/vulkan_kopt_2026-05-11.json`.
(The fork's `build/linux-x64-vulkan/llama-cli` exists and runs, but a full
`llama-bench`-style end-to-end run was not feasible during this pass — the box
was at load average ~25–30 from concurrent sibling agents and a 32-token 0.6B
Vulkan generation did not complete inside a 200 s budget. Recorded as remaining
work below.)

## 2. Profile — what dominates on Intel ANV

Per-dispatch GPU time, idle box (medians, µs):

| kernel | n_kv 512 | n_kv 4096 | n_kv 32768 |
| --- | ---: | ---: | ---: |
| turbo3 | 116 | 679 | 7100 |
| turbo4 | 121 | 686 | 6177 |
| turbo3_tcq | 118 | 661 | 5953 |
| qjl | 256 / 783* | 5784 / 5957* | 15060 / 27579* |
| polar | 45 | 187 | 1691–2878 |
| polar_preht | 42 | 203 | 1684–3811 |
| fused_attn_qjl_tbq | 6187 | 34447–61607 | 266k–340k |
| fused_attn_qjl_polar | 3095–4552 | 23716–29281 | 188k–236k |

(* the QJL row is grid-shape-sensitive: it dispatches `n_heads × n_tokens`
workgroups vs turbo's `n_kv`, so at the n_heads=8 used here it's ~6–8× more
work-items than the turbo rows. The two numbers bracket idle vs loaded.)

Findings:

1. **QJL is the dominant standalone KV kernel at scale.** ~15–28 ms at 32k vs
   ~6–12 ms for turbo* and ~2–4 ms for polar. The cost is per-workgroup launch
   tax × the huge `n_heads × n_tokens` grid plus a per-token reload of the
   256-wide q_sketch + its ±1 sign vector. The fix already in tree is
   `qjl_multi.comp` (TOKENS_PER_WG fold, hoists q0/q1 out of the token loop);
   the runtime routes it above a threshold.
2. **turbo*_multi gives essentially nothing below 32k on Intel ANV** — these are
   memory-bandwidth-bound at n_kv ≥ 512; `BLOCKS_PER_WG ∈ {8,16}` is a wash at
   512 and a slight *regression* at 4k (679→720 µs). At 32k it's a real win
   under contention (turbo3 12.4 ms → 5.9 ms with factor 8) and neutral when
   idle (~7 ms → ~7 ms).
3. **polar / polar_preht are already cheap** (~2 ms at 32k) and within noise of
   each other on this hardware — preht's win is the per-K-row Hadamard removal,
   which barely registers when polar wasn't the bottleneck.
4. **fused_attn_* is catastrophically slow on Intel ANV** — 266 ms (TBQ) / 188 ms
   (Polar) at 32k vs ~20 ms for the unfused score→softmax→V path. Root cause:
   the kernel dispatches **one workgroup per head** (8 WGs total) and walks all
   32k tokens serially inside each, twice (a max/sum pass then a V-mix pass).
   8 WGs cannot fill an Arc/Xe. The fused path is *not* on the runtime hot path
   (`kernel-contract.json`: `fused_attn` is registered but not a
   `requiredRuntimeCapabilityKey`), so this is a future rewrite, not a
   regression — but on this device class the standalone score + ggml softmax +
   V-mat-vec is dramatically faster and should stay the default.

## 3. Optimizations landed (ranked by measured impact, all parity-preserving)

### 3.1 Device-policy thresholds for the `_multi` routes — `vulkan-kernels.mjs`

The runtime-dispatch patch previously used one pair of constants
(`MILADY_VK_MULTIBLOCK_FACTOR=4`, `THRESHOLD=2048`) for *all* `_multi` routes on
*all* devices. Split into QJL vs TBQ, tuned from the bench:

- **QJL: keep `TOKENS_PER_WG=4`, lower the engage threshold 2048 → 1024.**
  `qjl_multi` at factor 4 beats single-block at *every* measured length
  (~1.3× at 512 tokens, ~1.8× at 4k, ~1.6–1.9× at 32k) and stays the safe
  value across system load — factor 8 was marginally faster on an idle box but
  ~25% *slower* under heavy contention (fewer workgroups to hide latency), so
  the literal `{4u}` spec constant baked into the `qjl_multi` pipeline at
  `ggml_vk_load_shaders` time is unchanged; only the dispatch threshold moved.
- **TBQ (turbo3/turbo4/turbo3_tcq): keep `BLOCKS_PER_WG=4`, raise the engage
  threshold 2048 → 8192.** The fold is a wash at 512 and a slight regression at
  4k on Intel ANV; only at ≥ ~16–32k is it a clear win. Raising the threshold
  means the common 512–4k decode loop never pays the fold tax, while the long
  non-voice scan still gets the ~2× at 32k. (`{4u}` is the conservative
  cross-device value the kernel-optimization review picked for
  Adreno/Mali/AMD/NVIDIA — left as the cross-device default; per-device
  matching on `device->vendor_id` is the seam for future hardware.)

Expected impact at the 1.7B 4k–32k context tiers: QJL scoring is the heaviest
KV op, so engaging `qjl_multi` from 1k tokens shaves ~40–45% off the QJL
dispatch where it previously ran single-block (1024–2047 tokens). At 32k both
QJL (~1.8×) and turbo* (~2× under load) get the fold.

### 3.2 Single-pass online softmax in the fused-attn shaders

`vulkan/fused_attn_qjl_tbq.comp` and `vulkan/fused_attn_qjl_polar.comp` walked
the KV twice: pass 1 to find the global `(m, l)`, pass 2 to re-derive
`w_t = exp(raw_t - m)/l` and FMA the decoded V block in (with a no-op
`corr == 1.0` rescale). Rewrote both to the genuine FlashAttention recurrence —
one walk, `m_new = max(m, raw_t)`, `corr = exp(m_old - m_new)`,
`w = exp(raw_t - m_new)`, `l = l*corr + w`, decode-V into `acc_o*corr + w*dec`,
then a final `acc_o /= l` pass. The `corr` argument was already plumbed through
both `*_decode_token_into_acc` helpers (used as 1.0), so this is a small,
local change. It computes the per-token QJL score and its 32-thread tree
reduction **once instead of twice** — measured ~15–20% off the fused path on
Intel ANV (fused_attn_qjl_polar 32k: 236 ms → 188 ms; 4k: 29 ms → 24 ms; the
TBQ variant moved less because its per-token cost is dominated by the V-decode's
Hadamard-32 + codebook, not the QJL score). Doesn't fix the 8-WG grid problem,
but it's a free correctness-equivalent win and brings the fused path closer to
the unfused one. Parity: `make vulkan-verify-fused` 1920/1920 on Intel ARL,
max_diff 7.2e-7 (was 6.3e-7 — noise level).

## 4. Spec-constant device-policy table

| device class (match on) | QJL `TOKENS_PER_WG` | QJL engage threshold | TBQ `BLOCKS_PER_WG` | TBQ engage threshold |
| --- | --- | --- | --- | --- |
| **Intel Arc/Xe iGPU** (vendorID 0x8086, ARL/Xe-LPG, Mesa ANV) | 4 | 1024 tokens | 4 | 8192 tokens |
| **default / unprofiled** (Adreno, Mali, AMD, NVIDIA, …) | 4 | 1024 tokens | 4 | 8192 tokens |

(The two rows are currently identical — the bench only covered Intel ANV, and
the new thresholds are conservative enough to be a safe cross-device default.
The seam for divergence is `device->vendor_id` in
`ggml_vk_load_shaders` / the dispatch helpers; Adreno was suggested for a
`{2,4,8}` sweep and Mali for low barrier pressure in the review, both
needs-hardware.) The pipelines are still created with `constant_id=0 == 4`; if a
future device wants a different fold the `02-ggml-vulkan-pipelines.patch` hunk
and the `MILADY_VK_*_MULTIBLOCK_FACTOR` dispatch divisors must move together.

## 5. Parity confirmation (all on Intel ARL Mesa ANV, real hardware)

- `make -C packages/inference/verify vulkan-verify` — 8/8 PASS (turbo3, turbo4,
  turbo3_tcq, qjl, polar, polar+QJL-residual, polar_preht, polar_preht+QJL),
  max diff ≤ 7.6e-6.
- `make -C packages/inference/verify vulkan-verify-multiblock` — 16/16 PASS
  (4 kernels × N ∈ {2,4,8,16}).
- `make -C packages/inference/verify vulkan-verify-fused` — 1920/1920 PASS
  (fused_attn_qjl_tbq + fused_attn_qjl_polar, 4 cases each), max diff ≤ 7.2e-7.
- `make -C packages/inference/verify vulkan-dispatch-smoke` — 7/7 PASS against
  the existing `linux-x64-vulkan` fork build (`GGML_OP_ATTN_SCORE_{QJL,TBQ×3,
  POLAR×2}` + `GGML_OP_FUSED_ATTN_QJL_TBQ`). NB: this binary predates this
  pass's shader edits — the new shaders + device-policy land in a fresh
  `build-llama-cpp-dflash.mjs --target linux-x64-vulkan` (the patch stages the
  updated `.comp` files and applies the new thresholds idempotently).
- `node -e import('vulkan-kernels.mjs')` — module loads, exports intact.

## 6. What's left

1. **Fork rebuild + end-to-end `llama-bench`.** Not done this pass — the box was
   too contended and a Vulkan iGPU rebuild + 0.6B/1.7B generation didn't fit the
   budget, and `build-llama-cpp-dflash.mjs` `git reset --hard`s the fork cache
   (other agents had `linux-x64-cpu-fused` binaries live). The shader sources +
   device-policy are committed; the next `--target linux-x64-vulkan` build picks
   them up. Then: `make vulkan-dispatch-smoke` for fresh-binary parity, and
   `llama-cli`/`llama-bench` on `eliza-1-0_6b.bundle` / `1_7b` with
   `-ngl 99 --cache-type-k qjl ...` at 512/4k/32k for the tokens/sec delta.
2. **fused-attn grid rewrite.** The 8-WG-per-head shape is the real bottleneck on
   any GPU with >8 EUs. A `(q_head, kv_tile)` 2D grid + a partial-(m,l,acc)
   reduction across tiles would turn it into a proper FlashAttention. Big change;
   the fused path is not on the runtime hot path yet, so the unfused score +
   ggml softmax + V-mat-vec stays the default and is much faster on Intel ANV.
3. **AMD wave64 / NVIDIA tuning.** The `_multi` thresholds are an Intel-ANV +
   conservative-default table. AMD (wave64, 64 KB LDS) and NVIDIA want their own
   sweep — the `device->vendor_id` seam is in place; needs hardware.
4. **Subgroup reductions.** Intel ANV's `subgroupSize=32` is fixed, so a
   `subgroupAdd` over a single 32-lane group would be correct here — but the
   kernels keep the portable shared-memory tree reduction to stay correct on
   8/16-lane Intel configs and on Mali/Adreno without a `requiredSubgroupSize`.
   Bench did not show the reduction as the bottleneck (it's the per-WG launch
   tax and KV bandwidth), so this is low priority.
5. **Mesa ANV codegen flake** on strided/parallel SSBO stores in
   `qjl_get_rows` / `polar_get_rows` (and why the fused-attn shaders write the
   128-element output from `tid==0` serially). Pre-existing, not on the hot
   path, not addressed here.
