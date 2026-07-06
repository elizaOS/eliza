/**
 * Deterministic microbenchmark helper for CI perf gates.
 *
 * A wall-clock `performance.now()` reading of one call is noisy and
 * machine-dependent — useless as a CI assertion. This runs a function many
 * times, discards a warm-up window (JIT / first-call allocation), and reports
 * robust summary statistics (median + p95) so a test can assert two kinds of
 * regression:
 *
 *  1. an ABSOLUTE budget on the median — catches a catastrophic slowdown
 *     (generous enough to survive a slow CI VM);
 *  2. a SCALING ratio between two input sizes — the deterministic teeth. If the
 *     work is roughly linear, doubling/10×-ing the input scales the cost
 *     proportionally; an accidental O(n²) (a nested scan, a quadratic
 *     string-concat) blows the ratio far past the size ratio regardless of how
 *     fast the machine is. Machine speed cancels out of a ratio, so this
 *     assertion is stable across laptops and CI runners.
 *
 * Pure + dependency-free so it is safe to import into any *.test.ts.
 */

export interface BenchResult {
  /** Median per-call time in milliseconds over the measured window. */
  medianMs: number;
  /** p95 per-call time in milliseconds. */
  p95Ms: number;
  /** Number of measured (post-warmup) calls. */
  samples: number;
}

export interface BenchOptions {
  /** Measured iterations (after warmup). Default 200. */
  iterations?: number;
  /** Warm-up iterations discarded before measuring. Default 20. */
  warmup?: number;
}

/**
 * Time `fn` over `iterations` calls (after `warmup` throwaway calls) and return
 * robust per-call statistics. `fn` is called for its side effect of doing the
 * work; return values are ignored but the caller should ensure the result is
 * used (e.g. summed) so a dead-code-eliminating engine can't skip the work.
 */
export function benchmark(
  fn: () => void,
  options: BenchOptions = {},
): BenchResult {
  const iterations = options.iterations ?? 200;
  const warmup = options.warmup ?? 20;

  for (let i = 0; i < warmup; i += 1) fn();

  const samples: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples[i] = performance.now() - start;
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 =
    samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  return { medianMs: median, p95Ms: p95, samples: iterations };
}
