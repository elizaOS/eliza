# Eliza-1 kernel benchmarks — Apple M4 Max (2026-05-10)

Throughput numbers for the five Eliza-1 kernels (TurboQuant Q3, Q4, TCQ +
QJL + PolarQuant) measured on Apple M4 Max. Companion to the correctness
matrix in [README.md](README.md) — those tables tell you the kernels are
right; these tell you they are fast.

These numbers are what calibrates the provisional gates in
[../../training/benchmarks/eliza1_gates.yaml](../../training/benchmarks/eliza1_gates.yaml).
Numbers below the calibrated thresholds = bundle does not ship.

---

## 1. Hardware fingerprint

- **Device**: Apple M4 Max (40-core GPU, 16-core CPU)
- **OS**: Darwin 25.2.0 (`xnu-12377.61.12`, kernel `T6041`)
- **Memory**: unified, peak GPU memory bandwidth ~546 GB/s (Apple spec)
- **Metal**: framework available (Metal Toolchain not installed; verifies
  use runtime JIT via `MTLDevice.newLibraryWithSource`)
- **Compiler**: `clang++` from Xcode CLT (`-O2 -ObjC++ -fobjc-arc`)

## 2. Methodology

Two binaries under `verify/`:

- `cpu_bench` — single-thread C reference baseline. `clock_gettime(CLOCK_MONOTONIC)`
  bracket. 1 warmup run, 3 timed runs, median reported. Self-contained, no Metal.
- `metal_bench` — Metal harness. Same JSON fixtures + same per-kernel
  parameters as `metal_verify`. `mach_absolute_time()` bracket around
  `MTLCommandBuffer.commit() + waitUntilCompleted()`. **50-iteration
  warmup**, then **1000 measured iterations** interleaved across all 5
  kernels (interleaving exposes any contention between kernels and avoids
  cold-state bias toward the first one).

Workload sized to one realistic attention step at the **9B-class /
desktop-9b** tier:

- `head_dim = 128`, `n_kv_heads = 32` (`qjl_kv_heads = 8` for the QJL GQA path)
- `seq = 4096` tokens
- → **131072 output blocks per dispatch** for every kernel

This is roughly the per-step KV-cache decode work for a Qwen3-9B sized
model with FA-vec attention at 4k context. Bigger contexts scale roughly
linearly in dispatch count.

Each kernel records: GPU median µs (per dispatch), GPU p99 µs (worst-case
under contention), CPU median µs (host-side bracket including queue +
wait), per-dispatch bytes read, derived bandwidth (GB/s), derived
GFLOP/s for the dot-product portion.

Raw JSON: `verify/bench_results/m4max_2026-05-10.json`,
`verify/bench_results/cpu_m4max_2026-05-10.json`,
`verify/bench_results/m4max_tgsweep_2026-05-10.json`,
`verify/bench_results/m4max_fp16ref_2026-05-10.json`.

To rerun: `make -C packages/inference/verify bench`.

## 3. Results — per-kernel throughput

| Kernel       | GPU median (µs) | GPU p99 (µs) | CPU median (µs) | BW (GB/s) | % of 546 GB/s peak | GFLOP/s | Blocks/s   | Single-kernel decode tok/s* |
| ------------ | --------------- | ------------ | --------------- | --------- | ------------------ | ------- | ---------- | --------------------------- |
| `turbo3`     | 290.7           | 1126.7       | 580.0           | 27.1      | 5.0%               | 115.4   | 4.51 × 10⁸ | 43.0                        |
| `turbo4`     | 289.4           | 1188.9       | 591.0           | 31.7      | 5.8%               | 115.9   | 4.53 × 10⁸ | 43.2                        |
| `turbo3_tcq` | 293.1           | 1288.9       | 600.0           | 25.0      | 4.6%               | 114.5   | 4.47 × 10⁸ | 42.6                        |
| `qjl`        | 287.5           | 1280.3       | 589.5           | 5.8       | 1.1%               | 116.7   | 4.56 × 10⁸ | 43.5                        |
| `polar`      | 585.8           | 1865.9       | 904.5           | 19.2      | 3.5%               | 57.3    | 2.24 × 10⁸ | 21.5                        |

*Single-kernel decode tok/s = `1 / (gpu_med_us × n_layers)` if you assume
one kernel dispatch per layer per step. Real generation tok/s is lower
because real flash-attention has more than just this one shader in the
critical path. Use the number to compare kernels against each other, not
as a real generation-throughput claim.

### What the numbers mean

- **GPU median ~290 µs for the 4 small kernels** → all four are
  launch-tax bound at this dispatch shape. The kernel body finishes way
  faster than the queue-submit / wait round-trip; with 131072 tiny
  threadgroups they all converge to the same per-dispatch overhead.
  This is fixable by **multi-block per dispatch** (Wave-4-B
  `SHADER_REVIEW_2026-05-10.md` items M3) — keeping the same shader
  but issuing fewer, fatter dispatches.
- **`polar` is 2× slower (586 µs)** because it does real per-block work
  (Hadamard butterfly + Lloyd-Max LUT + optional QJL residual). The
  Wave-4-B parallelization fix (12.5× speedup vs the pre-Wave-4-B
  single-thread butterfly) puts it in the same dispatch ballpark as the
  other four — without that fix, polar was a ~5.7 ms outlier.
- **CPU median is roughly 2× GPU median across the board** — the
  command-buffer round trip is on the order of 200-300 µs even when the
  kernel itself completes in <100 µs. This is per-dispatch GPU overhead
  on Apple Silicon; the only way to amortize is to **batch dispatches**.
- **Bandwidth utilization is low (1–6% of 546 GB/s peak)** because every
  one of these kernels is doing big arithmetic work per byte read. They
  are **compute-bound, not memory-bound** at this shape — except `qjl`
  which moves the smallest amount of data per dispatch (5.8 GB/s) and
  lives in the launch-tax regime.
- **GFLOP/s of ~115 for QJL/turbo and ~57 for polar** is dot-product
  only; if you count the Hadamard butterfly polar would be ~2× higher.

## 4. fp16 K-cache reference baseline

The unquantized alternative — bf16 K cache, fp16 dot product, no
quantization — for the same 131072 output blocks:

| Metric                    | Value           |
| ------------------------- | --------------- |
| GPU median (µs)           | 303.1           |
| GPU p99 (µs)              | 2034.0          |
| CPU median (µs)           | 759.0           |
| Bytes / dispatch          | 34,079,232 (256 B/token × 131072 tokens) |
| Bandwidth (GB/s)          | 112.4           |
| % of 546 GB/s peak        | 20.6%           |

**This is the throughput we would be shipping if we did NOT quantize.**

Comparing to the quantized kernels:

- The fp16 reference has **roughly the same dispatch latency** as the
  4 small Eliza-1 kernels (303 µs vs 290 µs) — confirming the launch-tax
  regime conclusion.
- It uses **20× more memory bandwidth** (112 GB/s vs 5.8 GB/s for QJL,
  vs 27 GB/s for turbo3) — which is the entire point of K-cache
  quantization. At 32k or 64k context lengths this is the difference
  between fitting in cache and thrashing main memory.
- Per-run variance was 107% — fp16 is NOT thermally stable here. The
  quantized kernels showed 0% per-run variance at the same iteration
  count. **Quantization gives us deterministic latency**, which matters
  for streaming TTS first-audio targets.

The takeaway: at single-step decode the quantization is bandwidth
insurance, not raw-speed insurance. The wins compound at long context
+ multi-step generation + battery/thermal limited mobile devices.

## 5. CPU reference baseline

Single-thread C reference, same workload (131072 blocks):

| Kernel       | Median (ms) | Min (ms) | Max (ms) | BW (GB/s) | GPU speedup |
| ------------ | ----------- | -------- | -------- | --------- | ----------- |
| `turbo3`     | 27.5        | 26.0     | 28.5     | 0.29      | **94.6×**   |
| `turbo4`     | 13.2        | 13.2     | 13.3     | 0.70      | **45.6×**   |
| `turbo3_tcq` | 19.4        | 19.3     | 22.6     | 0.38      | **66.1×**   |
| `qjl`        | 22.0        | 20.0     | 42.6     | 0.08      | **76.5×**   |
| `polar`      | 32.4        | 30.9     | 32.9     | 0.35      | **55.3×**   |

The C reference is single-threaded scalar — multi-thread + NEON SIMD on
the M4 Max would close some of this gap (the `qjl-cpu` and
`polarquant-cpu` packages have NEON dispatch paths). But for the
"can-CPU-do-this-instead-of-GPU?" question, the answer at this dispatch
shape is **no, GPU wins by 45-95×**.

## 6. Threadgroup-size sensitivity

Apple convention is one SIMD-group = 32 lanes per threadgroup. The QJL
and Polar kernels use `simd_sum` to reduce — so threadgroup > 32 silently
under-reduces unless rewritten to use shared scratch + barrier. The
sweep records dispatch success and timing; correctness is *not* validated
in this sweep:

| Kernel | tg=32     | tg=64     | tg=128    | tg=256    |
| ------ | --------- | --------- | --------- | --------- |
| `qjl`  | 338.7 µs  | 324.8 µs  | 562.5 µs  | 709.0 µs  |
| `polar`| 878.5 µs  | 1033.6 µs | 2415.5 µs | 7749.6 µs |

**Conclusions:**

- **`qjl` is fastest at tg=64**, marginally. tg=128 and tg=256 cost more
  due to underutilization (each thread does less inner work) and likely
  silent under-reduction. **Recommend keeping tg=32.**
- **`polar` strictly wants tg=32.** Beyond 32, the parallel butterfly
  starts contending with itself across SIMD-group boundaries and the
  reduction breaks. **Strongly recommend keeping tg=32.**

If we ever bump the threadgroup size, we MUST rewrite `simd_sum` to
shared scratch + barrier (already documented in the README's "most
likely on-hardware failure modes" #2).

## 7. Calibrated suggestions for `eliza1_gates.yaml`

Today the gates for `desktop-9b` are largely `provisional: true`. Based
on M4 Max measurements:

- **`voice_rtf <= 0.4` → defensible.** A single OmniVoice TTS forward at
  the desktop-9b tier should fit comfortably under 0.4× real-time on
  M4 Max given that even the slow polar kernel does 200M+ blocks/s.
  Recommend **keeping the 0.4 threshold but flipping `provisional: false`
  conditional on the first end-to-end TTS RTF measurement
  reproducing it.
- **`first_audio_latency_ms <= 400`** is loose at this tier: 1× audio
  chunk + 1× TTS forward + 1× phrase-chunker boundary should be well
  under 400 ms on M4 Max. Recommend **tightening to 250 ms** once the
  e2e harness is wired and reproduces it.
- **`first_token_latency_ms <= 200`** is tight. Single-step decode on
  M4 Max under TurboQuant Q4 + DFlash should land 50–120 ms. Keep 200 ms
  threshold; flip to non-provisional after empirical confirmation.
- **`dflash_acceptance >= 0.65`** depends on the trained drafter and is
  not benchmarkable from these kernel numbers. Stays provisional until
  there is an end-to-end run.

## 8. Perf surprises (handed off to Wave-5 shader work)

These are not landed; they are flagged to whoever picks up `SHADER_REVIEW_2026-05-10.md`:

- **All five kernels are launch-tax bound at this dispatch shape.**
  Multi-block per dispatch (M3 in shader review) is the single biggest
  available win — could push 4 small kernels from 290 µs → ~30 µs each
  by issuing 10× fatter dispatches.
- **`polar` is now the slowest** even after the 12.5× speedup, because
  its body actually does work. The Hadamard butterfly is ~57 GFLOP/s;
  fp16 Hadamard (M5 in shader review) would double this if the precision
  tradeoff is acceptable.
- **CPU side overhead is the same for every kernel (~580–600 µs)**.
  This is Apple's command-buffer overhead; it dominates the small
  kernels. Any throughput win below 290 µs/kernel needs to attack the
  dispatch shape, not the kernel body.

---

## 9. Multi-block dispatch (SHADER_REVIEW M3) — landed 2026-05-10

The four small kernels were launch-tax bound at the published 290 µs
median (one threadgroup per output block × 131072 tiny dispatches). Each
kernel now ships a sibling `_multi` entry point that keeps 32 threads per
threadgroup but loops serially over N consecutive KV blocks before
exiting, cutting the launch grid by N×.

| Kernel       | Single-block GPU median (µs)* | Best multi-block GPU median (µs) | Optimal N | Speedup |
| ------------ | ----------------------------- | -------------------------------- | --------- | ------- |
| `turbo3`     | 332.8                         | 76.5                             | 4         | 4.35×   |
| `turbo4`     | 400.9                         | 83.9                             | 8         | 4.78×   |
| `turbo3_tcq` | 350.7                         | 134.6                            | 8         | 2.60×   |
| `qjl`        | 408.4                         | 83.1                             | 8         | 4.92×   |

*Single-block readings are from the multiblock-mode harness running each
kernel in isolation (not interleaved with the other 4 + polar like §3),
so the absolute baseline is hotter than the §3 290 µs steady state. The
relative speedup column is what's robust.

**Key findings:**

- **3 of 4 small kernels hit ~4.5× speedup at N=4-8**, confirming the
  launch-tax hypothesis for `turbo3`, `turbo4`, `qjl`.
- **`turbo3_tcq` got 2.6×** — smaller than predicted because its inner
  loop already does more arithmetic per block (9-bit window extraction +
  codebook lookup), so launch tax was a smaller fraction of its runtime.
- **All four kernels regress past N=8-16.** At N=32 the threadgroup has
  so much serial work that the GPU's parallel slots starve. Sweet spot is
  N=4 for `turbo3`, N=8 for the rest.
- **The multi-block kernel at N=1 ≈ single-block kernel** (within a few
  percent), so the loop overhead itself is negligible — the entire win
  comes from amortising launch tax.
- **GPU p99 also drops** at the optimal N (e.g. `qjl`: 2172 µs → 1158 µs
  at N=16, 798 µs at N=32). Fewer threadgroups → fewer worst-case
  scheduling stragglers.

**Pre-existing single-block kernels are unchanged.** The `_multi` entries
are additive — `metal_verify` continues to pass 8/8 against the single-
block fixtures, and a new `--multi N` flag verifies the multi-block entries
against the same fixtures (also 8/8 PASS at N=2,3,4,8).

Raw JSON: `verify/bench_results/m4max_multiblock_2026-05-10.json`. Reproduce
via `make -C packages/inference/verify metal-bench-multiblock` or the
umbrella `make -C packages/inference/verify bench`.

## How to reproduce

```bash
cd packages/inference/verify
make bench
ls bench_results/
```

The `bench` target runs `cpu_bench` + `metal_bench` (default mode +
`tgsweep` mode + `fp16ref` mode) and writes 4 JSON files. Re-runs
overwrite. The JSON is the source of truth — this doc is a one-time
human-readable digest. Future bench runs should diff JSON-to-JSON, not
edit this doc.
