# CPU kernel optimization — Eliza-1 0.6B / 1.7B loop (2026-05-11)

Scope: the CPU KV-cache kernels this agent owns —
`packages/native-plugins/qjl-cpu/*`, `packages/native-plugins/polarquant-cpu/*`,
`packages/inference/reference/turbo_kernels.c` (the C reference / spec),
`packages/inference/verify/cpu_bench.c` (+ the new `cpu_simd_bench.c`).
Dev box: Intel Core Ultra 9 275HX (Arrow Lake-HX, 24 cores; AVX2 +
AVX-VNNI + F16C + SHA-NI, **no AVX-512**; L2 40 MB / L3 36 MB).

## What the predecessor left vs. what this pass finished

The predecessor (terminated mid-work by a rate limit) had landed, via the
swarm-checkpoint commit `b8dd8a6f08`:

- the runtime AVX-VNNI int8-sketch QJL score kernel
  (`qjl_score_avxvnni.c`, `qjl_score_qk_i8_avxvnni`) — already well tuned
  (two independent `VPDPBUSD` accumulator chains, hoisted q chunks,
  1:1 bit-expand→`VPDPBUSD` ratio). Verified bit-exact vs `qjl_score_qk_i8_ref`.
- the Polar pre-Hadamard scalar reference + the runtime dispatch wiring
  (`ggml_vec_dot_q4_polar_preht_f32{,_ref,_avx2}`) — the `dot(H·x, q) ==
  dot(x, H·q)` algebra that kills the per-K-row 7-stage Hadamard and the
  128-float decode-to-scratch.
- the `_POSIX_C_SOURCE` fix for `cpu_bench.c`, the D3 MT-vs-ST correctness
  driver, and the AVX-VNNI / D3 bench JSONs.

**But it left `polar_dot_preht_avx2.c` broken:** a WIP refactor changed
`unpack8_centroids()` to take hoisted `clo`/`chi` centroid-LUT halves and
never updated the four call sites — the `polarquant-cpu` plugin (and the
fork's `ggml-cpu/polarquant/` via the patcher) **failed to compile**, which
also blocks the next `linux-x64-cpu` fork build's polar TU.

This pass:

1. **Fixed `polar_dot_preht_avx2.c`** — pass `clo`/`chi` through to the
   four `unpack8_centroids` calls. Build green; `polar_preht_simd_parity_test`
   rel ≤ 1.8e-7 vs the preht ref for both `use_qjl=0/1`; `polar_simd_parity_test`
   rel ≤ 1.6e-7; `polar_preht_dot_test` rel ≤ 3.6e-7.
2. **Rewrote `qjl_score_qk_avx2`** (the exact-fp32 QJL score path — the
   default the QJL graph op calls; the int8 path is still experimental).
3. **Added `cpu_simd_bench.c`** + a `cpu-simd-bench` Makefile target.

## Profile — what dominates at 0.6B / 1.7B scale

The five reference KV kernels at the production attention workload
(`head_dim=128`, `seq=4096` ⇒ 131072 outputs; QJL `n_kv_heads=8` ⇒ 32768
packed K rows), single-thread scalar C (`bench_results/cpu_d3_thread_parallelism_2026-05-11.json`):
turbo3 ≈ 21.9 ms, turbo4 ≈ 13.5 ms, turbo3_tcq ≈ 19.9 ms, polar ≈ 35.0 ms,
**qjl ≈ 127.6 ms** — the QJL K-score dominates by ~6× over the next-worst.

For the SIMD plugin paths (which is what the fork's `ggml-cpu` actually
runs), at the same workload (`cpu_simd_bench`, quiet machine):

| Kernel (SIMD path)            | ns / output | notes |
| ----------------------------- | ----------: | ----- |
| `qjl_score_qk_i8` (AVX-VNNI)  |        ~4–5 | experimental int8 sketch; bit-exact vs i8 ref, ~1.2e-3 abs vs the exact fp32 baseline |
| `qjl_score_qk_avx2` (fp32, **before**) |     ~23 | recorded `cpu_avxvnni_2026-05-11.json`: 3005.4 µs / 131072 = 22.9 ns; `qjl_bench --throughput` (32k-out, L2-resident): ~123 ns |
| `qjl_score_qk_avx2` (fp32, **after**)  |  **~9**  | `cpu_kopt_2026-05-11.json`; `qjl_bench --throughput`: ~15 ns |
| `ggml_vec_dot_q4_polar_preht_f32` (AVX2) |  ~22 | already optimized last pass (`polar_bench`: 22 ns/row) |
| `dequantize_row_q4_polar` (AVX2 legacy decode) | ~118 | exact-decode fallback only — runtime uses the preht path |

So the QJL fp32 score is the single biggest CPU-side lever once the int8
path is the verification baseline rather than the default. (Note: the dev
box was under heavy contention from concurrent sibling fork builds at the
time of the final measurements — load avg 22→102 — so the absolute numbers
above are the low-load readings; under bandwidth contention the LUT-gather
path's win shrinks to ~1.4× because it competes for memory while the old
FMA-chain path was compute-bound.)

## Optimizations landed (ranked by measured impact)

### 1. `qjl_score_qk_avx2` — partial-sum LUT + 4×`VGATHERDPS` (≈2.5–8×)

The query sketch `qs` (256 fp32) is constant across the whole token loop
for a head; only the 32 sign bytes vary per token. The per-byte partial
sum

    part(b, v) = Σ_{k=0..7} ((v>>k & 1) ? 1 : -1) · qs[8b + k]

depends only on the byte position `b ∈ [0,32)` and value `v ∈ [0,256)`.
Build a 32×256 = 8192-float per-head table once (8192 hsums of an 8-vector;
≈ <1 token of work at `n_tokens ~ 4k`), laid out `tbl[b·256 + v]` (32 KB,
L1-resident, on the stack — no `malloc`, thread-safe over disjoint head
ranges). Then per token: load the 32 bytes ⇒ 4 ymm of i32 indices
`b·256 + sign_byte[b]` ⇒ 4×`_mm256_i32gather_ps` ⇒ 3 adds + a tail reduce.

This replaces the previous **32-deep dependent FMA chain** (≈4c × 32
latency per token) **plus 32 per-byte bit-expand sequences**
(`set1`/`and`/`cmpeq`/`blendv`) with a memory-bound gather of an
L1-resident table. Parity: not bit-identical to `qjl_score_qk_ref` (FP
reassociation — same as the prior AVX2 path), verified `avx2 score 256/256,
worst rel diff 2.5e-6` vs the fixture.

`qjl_bench --throughput` (32768-output, fits L2): **~123 ns → ~15 ns ≈ 8×**
on a quiet box. `cpu_simd_bench` (131072-output, exceeds L2): **~23 ns →
~9 ns ≈ 2.5×**. Both stable across reps when the machine isn't contended.

### 2. `polar_dot_preht_avx2.c` build fix (unblocks the fork CPU build)

Not a perf change per se, but the predecessor's WIP left this TU
non-compilable, which broke `polarquant-cpu` and the fork's
`ggml-cpu/polarquant/` (and therefore the next `linux-x64-cpu` build's
polar V-cache dot). Fixed; parity tests green (see above).

## End-to-end / fork build status

A clean `linux-x64-cpu` fork build + `llama-bench` on the real
`eliza-1-0_6b` / `eliza-1-1_7b` text GGUFs was **not done this pass**:
at the time, two sibling agents were each running a `-j24` fork **CUDA**
build (`packages/inference/llama.cpp/build/linux-x64-cuda` and a separate
`/tmp/llcpp-bench/build-cuda`) plus a full-`/` `bfs` scan — load average
22 → 102. Starting a CPU fork build (which `git reset --hard`s and
re-patches the submodule) would have raced those builds, and any
`llama-bench` reading under that contention is meaningless. The existing
cached `linux-x64-cpu/bin/libggml-cpu.so` (May 11 10:13) predates these
plugin changes anyway, so it wouldn't reflect them.

Note also: that build's `llama-cli`/`llama-bench` do **not** accept
`-ctk qjl` / `-ctv q4_polar` — the QJL/Polar paths in the fork are
graph-level fused ops (`GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_FUSED_ATTN_QJL_TBQ`,
`ggml_vec_dot_q4_polar_*`) wired by the patcher, not selectable CLI cache
types. The `cpu_simd_bench` harness times those entrypoints directly via
the plugin static libs, which is the reproducible CPU evidence here.

**To complete:** once the box is quiet, `node packages/app-core/scripts/build-llama-cpp-dflash.mjs
--target linux-x64-cpu` (no env vars needed — the structured-output patch is
now tolerant of fork drift; the CPU target's kernel-completeness gate still
needs `ELIZA_DFLASH_ALLOW_REDUCED_KERNELS=1` for a runnable reduced binary),
then `make -C packages/inference/verify reference-test kernel-contract` (already
green) and a `llama-bench`/`llama-cli` run on the 0.6B/1.7B bundles with the
QJL/Polar graph routes active; record the decode + prompt-eval t/s delta and
the 1/4/8/16/24-thread curve to `bench_results/cpu_kopt_2026-05-11.json`.

## Thread scaling

`cpu_simd_bench --threads "1 4 8 16 24"` (OpenMP over disjoint head /
row ranges — no reduction, bit-identical to T=1):

- `polar_preht_dot` (131072 rows): scales ~7–8× at 16 threads on a quiet
  box (7.2 ms → 0.95 ms); good — it's a flat row loop with no per-call
  setup.
- `qjl_score_*` (32 heads): poor scaling because each per-head call is
  only ~18 µs, so OpenMP fork/join overhead dominates. In the real fork
  the ggml thread pool wraps the whole attention op in one parallel
  region (not per-head), so this is a harness artifact, not the runtime
  shape. The D3 driver already confirmed the patched `GGML_OP_ATTN_SCORE_QJL`
  / `GGML_OP_FUSED_ATTN_QJL_TBQ` are bit-identical at `n_threads=1` vs `24`.

## Parity confirmation

- `make -C packages/inference/verify reference-test`: self-test
  `turbo3=-2.501480 turbo4=-23.721790 turbo3_tcq=-4.822659 qjl=3.696591
  polar=-1.994053 polar_qjl=-1.438744` (all finite; fused-attn + TBQ
  V-cache parity OK).
- `make -C packages/inference/verify kernel-contract`: `OK kernels=6
  targets=21 manifestNames=6`.
- `qjl_bench --parity <fixture>`: `ref score 256/256 (worst 5.78e-6)`,
  `avx2 score 256/256 (worst 2.5e-6)`, `ref/avx2 quantize 64/64 OK`.
- `qjl_avxvnni_smoke`: `active=avxvnni max_abs=0.0 failures=0` (int8 path
  unchanged).
- `polar_preht_simd_parity_test` / `polar_simd_parity_test` /
  `polar_preht_dot_test`: rel ≤ 3.6e-7 across `use_qjl=0/1`.

## What's left

1. Quiet-machine fork `linux-x64-cpu` build + `llama-bench` on the 0.6B /
   1.7B bundles with QJL/Polar graph routes active — decode + prompt-eval
   t/s before/after, per-op breakdown, 1/4/8/16/24-thread curve.
2. `perf record` of the built `libggml-cpu.so` on the real models once
   built (`/proc/sys/kernel/perf_event_paranoid` permitting).
3. The int8 QJL sketch path (`qjl_score_qk_i8_avxvnni`) is ~2× faster than
   the new fp32 path but is still gated as experimental — needs a fixture
   family + end-to-end model tolerance gate before it can become the
   default QJL score route (per the kernel-optimization-review P1 item).
4. `polar_dequantize_avx2.c` legacy exact-decode path is ~118 ns/row; only
   matters for the non-preht fallback, low priority.
