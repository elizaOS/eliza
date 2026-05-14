# Eliza-1 Metal kernel batched-dispatch sweep — Apple M4 Max, 2026-05-10

Wave-6 follow-up to `bench_M4Max_2026-05-10.md`. Wave-5 observed that 4 of 5
Metal kernels cluster at ~240 µs median GPU time regardless of buffer size;
the working hypothesis was a command-buffer-launch / threadgroup-schedule
floor that batching could amortise. This report tests that hypothesis on
hardware and documents the surprising answer.

## Harness

`verify/metal_bench.mm` extended with `--mode batched`. For each of the 5
shipped kernels we encode N ∈ {1, 4, 16, 64, 128, 256} `dispatchThreadgroups`
calls into one `MTLComputeCommandEncoder`, end-encoding once, commit once,
`waitUntilCompleted` once. Bindings are bound once and reused across all N
dispatches (this is the same pattern a real production batched dispatcher
would use). GPU-side total measured via `GPUEndTime − GPUStartTime`; per-
dispatch cost = total / N.

Run with:

```
make -C verify metal-bench-batched      # builds + runs
./verify/metal_bench --mode batched     # output → bench_results/m4max_batched_2026-05-10.json
```

iters_per_N=32, warmup=16 (auto-reduced at N≥64/128 to keep wall <15 min).
Total measurement wall: **14.8 s**. Builds with `-O2 -Wall -Wextra`, no
warnings.

## Per-kernel × per-N grid (median GPU µs)

| Kernel       |  N=1   |  N=4   |  N=16  |  N=64   |  N=128  |  N=256  |
|--------------|-------:|-------:|-------:|--------:|--------:|--------:|
| `turbo3`     | 270.87 | 1041.85 | 3697.00 | 14553.31 | 29520.56 | 65014.67 |
| `turbo4`     | 253.31 | 1012.85 | 4097.96 | 16184.44 | 32799.87 | 64447.60 |
| `turbo3_tcq` | 236.31 | 945.46  | 3868.60 | 16028.15 | 33040.40 | 66857.79 |
| `qjl`        | 255.69 | 995.96  | 3974.67 | 16261.90 | 31523.06 | 62995.29 |
| `polar`      | 458.44 | 1977.02 | 9303.23 | 56494.44 | 137950.60 | 278492.10 |

**Per-dispatch amortised cost (µs):**

| Kernel       | N=1 | N=4 | N=16 | N=64 | N=128 | N=256 |
|--------------|----:|----:|-----:|-----:|------:|------:|
| `turbo3`     | 270.9 | 260.5 | 231.1 | 227.4 | 230.6 | 254.0 |
| `turbo4`     | 253.3 | 253.2 | 256.1 | 252.9 | 256.3 | 251.8 |
| `turbo3_tcq` | 236.3 | 236.4 | 241.8 | 250.4 | 258.1 | 261.2 |
| `qjl`        | 255.7 | 249.0 | 248.4 | 254.1 | 246.3 | 246.1 |
| `polar`      | 458.4 | 494.3 | 581.5 | 882.7 | 1077.7 | **1087.9** |

## The surprising finding: there is no launch floor

Wave-5's 240 µs cluster is **not** a command-buffer-launch tax. Batching
24 dispatches into one buffer drops total cost roughly linearly with N
(per-dispatch ≈ 230–260 µs at every batch size). If launch overhead were the
floor, per-dispatch cost would collapse toward zero as N grows; it doesn't.

What the cluster actually is: **memory-bandwidth saturation at the kernel
level**. Each turbo*/qjl dispatch reads ~7–18 MB of packed K-cache plus a
~512 KB output buffer; at 546 GB/s peak, ~17 MB ÷ 546 GB/s ≈ 31 µs is the
theoretical lower bound, but actual achieved bandwidth is 5–7× lower than
peak (consistent with the 5–7 % bw-pct numbers in Wave-5). The kernels are
hitting *their own* bandwidth ceiling, not a per-launch overhead.

`turbo3` at N=64 (227.4 µs) is the best amortised number — a **16 % win**
over single-dispatch (270.9 µs), suggesting a small but real launch-tax
component (~40 µs absorbed). For `turbo4` / `qjl` / `turbo3_tcq` the win is
under 5 %, well inside run-to-run variance.

`polar` actively **loses** on batching: per-dispatch cost grows from 458 µs
(N=1) to 1088 µs (N=256), a 2.4× regression. This is the Wave-3 cooperative-
Hadamard kernel; its 11 264-thread grid (`kPolarRows = 131072`) already
saturates the 40-core GPU at N=1. Batching forces the GPU to serialise
dispatches with full-grid context; the second through Nth dispatches wait
for the first's threadgroups to drain. **Polar must remain single-dispatch.**

## Knee in the curve

There isn't one. The launch floor doesn't disappear because it isn't there:

- turbo3:  knee absent (227–271 µs across the entire sweep).
- turbo4 / qjl / turbo3_tcq: launch overhead is ~5 µs per dispatch at most.
- polar: anti-knee at N=4 (already worse than N=1).

**Production conclusion:** batched command buffers are NOT the win Wave-5
predicted. The real win has to come from kernel-level bandwidth optimisation
(K-cache layout, fp16 scratch, KV-cache compression — or moving to fused
flash-attention kernels that read K once and reuse).

## Barge-in latency vs throughput tradeoff

Voice scaffold contract: barge-in must cancel ≤1 kernel-tick (~250 µs).
A `MTLCommandBuffer` is the minimum cancellation unit — the GPU cannot
preempt mid-buffer. Cancellation latency = wait for the in-flight buffer to
drain.

| N    | Worst-case barge-in (µs) | Avg barge-in (µs) | Voice contract holds? |
|-----:|-------------------------:|------------------:|----------------------:|
|    1 |   ~270 (turbo*) / 458 (polar) | ~135 / ~230 | **YES** (one tick) |
|    4 |  ~1 000                  | ~500              | borderline (4 ticks)  |
|   16 |  ~3 700–9 300            | ~1 850–4 650      | **NO** (15+ ticks)    |
|   64 | ~14 500–56 500           | ~7 250–28 250     | **NO**                |
|  128 | ~29 500–138 000          | ~14 750–69 000    | **NO**                |
|  256 | ~62 000–278 500          | ~31 000–139 250   | **NO**                |

The contract breaks at N≥4 for any kernel. For voice paths, **N=1 is
mandatory**. Throughput-oriented batched dispatch can only land on
non-interactive paths (background prefill, summarisation, eval).

## Production wiring — where batched dispatch would hook in

If/when a future kernel becomes launch-bound (it isn't today), the entry
point is in `dflash-server.ts`'s spawn argument construction. The runtime
talks to llama-server via stdio + HTTP, so "batched dispatch" at the TS
layer means a `--batch-size N` knob threaded into the spawn args that the
Metal backend then honours when it chooses how many K-cache score
operations to coalesce per command buffer.

**File:line targets for the next person:**

- `packages/app-core/src/services/local-inference/dflash-server.ts:607`
  — `appendOptimizationFlags()` is the canonical chokepoint where every
  optimisation flag (lookahead, ngramDraft, MoE offload, mlock, mmproj, fa)
  is appended. A `metalBatchSize` field on `LocalRuntimeOptimizations`
  routes here. Pseudo-interface:

  ```ts
  // optimizations: { metalBatchSize?: 1 | 4 | 16 | 64 }
  if (opts.metalBatchSize && opts.metalBatchSize > 1) {
    args.push("--metal-batch", String(opts.metalBatchSize));
  }
  ```

- `packages/app-core/src/services/local-inference/dflash-server.ts:893`
  — array literal where final args are assembled. The `--metal-batch` flag
  needs to land here for the spawned llama-server invocation to receive it.

- `packages/app-core/src/services/local-inference/dflash-server.ts:967`
  — `spawn(status.binaryPath, args, ...)` — the actual child process spawn.
  No code change here; just the receiving end of the new arg.

The llama-server side does not currently expose this knob; wiring requires
the patched llama.cpp Metal backend to accept `--metal-batch` and use it
at the score-kernel dispatch site. That work is out of scope for Wave-6.

**Voice path callers must opt out:** any voice/realtime path that calls
the local runtime must pass `metalBatchSize: 1` (or omit it) — never
≥4. Other-agent work on `dflash-server.ts` should preserve this default
(N=1 is the safe, voice-compatible setting).

## Verification

- `make -C verify metal-bench` — builds clean, **no warnings**.
- `./metal_bench` (existing default mode) — unchanged numbers, ~290 µs
  cluster + ~590 µs polar at iters=200/warmup=20. **No regression** in the
  single-dispatch baseline.
- `./metal_bench --mode batched` — total wall **14.78 s**, well inside the
  15-minute budget.
- All 5 shaders re-verified via `metal_verify` after the bench harness
  rebuild: **8/8 PASS** on every kernel. Max diff observed:
  - turbo3: 1.91e-06
  - turbo4: 5.72e-06
  - turbo3_tcq: 6.68e-06
  - qjl: 1.14e-05
  - polar: 7.63e-06

  All well below the 1e-3 tolerance. Shaders untouched; bench is purely
  additive.

## Files modified

- `verify/metal_bench.mm` — added `--mode batched` (single-dispatch path
  preserved; new mode is additive).
- `verify/Makefile` — added `metal-bench-batched` sibling target.
- `verify/bench_results/m4max_batched_2026-05-10.json` — full per-kernel
  per-N grid as JSON.
- `bench_M4Max_batched_2026-05-10.md` — this report.

No production code (`dflash-server.ts`, `engine.ts`) was touched.
