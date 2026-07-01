/**
 * Memory soak / leak-slope harness.
 *
 * Runs a workload repeatedly while sampling heap usage, then reports the
 * growth and per-iteration slope. The same harness wraps two things:
 *   1. a deterministic CI leak test (does a fixed workload climb unboundedly?),
 *   2. the live soak lane, where `workload` drives the real message loop +
 *      scheduled tasks so a sustained run proves steady-state RSS is flat.
 *
 * This closes the hole documented in
 * `packages/agent/src/__tests__/plugin-lifecycle-leaks.test.ts`: a leak that the
 * lifecycle system does not catch is caught here as unbounded heap slope.
 *
 * @module memory-soak
 */
import process from "node:process";
import v8 from "node:v8";
import vm from "node:vm";

/** One heap sample taken between workload iterations. */
export interface SoakSample {
  /** Iteration index (0-based) the sample was taken after. */
  iteration: number;
  /** `process.memoryUsage().heapUsed` in megabytes. */
  heapUsedMb: number;
  /** `process.memoryUsage().rss` in megabytes. */
  rssMb: number;
}

/** Aggregate result of a soak run. */
export interface SoakResult {
  samples: SoakSample[];
  /** Heap used at the first sample, MB. */
  baselineHeapMb: number;
  /** Peak heap used across the run, MB. */
  peakHeapMb: number;
  /** Net heap growth (last − baseline), MB. May be negative if GC reclaimed. */
  growthMb: number;
  /** Least-squares slope of heapUsedMb over iteration index, MB per iteration. */
  slopeMbPerIter: number;
}

export interface SoakOptions {
  /** Number of workload iterations. */
  iterations: number;
  /**
   * The unit of work. Called once per iteration; may be async. For the leak
   * test this allocates; for the live lane it drives one message-loop turn.
   */
  workload: (iteration: number) => void | Promise<void>;
  /** Optional async hook between iterations (e.g. to let timers/GC run). */
  betweenIterations?: () => Promise<void>;
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/**
 * Resolve a `gc()` handle. Prefers a `--expose-gc` global, otherwise obtains one
 * via the V8 flag + a fresh VM context (a standard Node trick) so the soak loop
 * can force collection before sampling — which makes `heapUsed` reflect *retained*
 * memory and turns the leak-vs-steady signal deterministic regardless of how the
 * process was launched. Returns `undefined` if a handle can't be obtained.
 */
function resolveGc(): (() => void) | undefined {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (typeof existing === "function") return existing;
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc: unknown = vm.runInNewContext("gc");
    v8.setFlagsFromString("--no-expose-gc");
    return typeof gc === "function" ? (gc as () => void) : undefined;
  } catch {
    return undefined;
  }
}

/** Least-squares slope of y over x = 0..n-1. */
function leastSquaresSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Run `workload` `iterations` times, sampling heap/RSS after each iteration, and
 * report growth + slope. Triggers `global.gc()` before sampling when Node was
 * started with `--expose-gc`, which makes steady-state runs far less noisy.
 */
export async function runSoak(options: SoakOptions): Promise<SoakResult> {
  const samples: SoakSample[] = [];
  const forceGc = resolveGc();

  for (let i = 0; i < options.iterations; i += 1) {
    await options.workload(i);
    if (options.betweenIterations) {
      await options.betweenIterations();
    }
    forceGc?.();
    const usage = process.memoryUsage();
    samples.push({
      iteration: i,
      heapUsedMb: bytesToMb(usage.heapUsed),
      rssMb: bytesToMb(usage.rss),
    });
  }

  // A zero-iteration soak yields no samples — there is no baseline/growth to
  // report, so return an explicit all-zero result rather than coalescing
  // missing data to 0 downstream. Narrowing first/last to a defined sample lets
  // the slope math run on a guaranteed-non-empty series.
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) {
    return {
      samples,
      baselineHeapMb: 0,
      peakHeapMb: 0,
      growthMb: 0,
      slopeMbPerIter: 0,
    };
  }

  const heapSeries = samples.map((s) => s.heapUsedMb);
  const baselineHeapMb = first.heapUsedMb;
  const peakHeapMb = Math.max(...heapSeries);
  const growthMb = last.heapUsedMb - baselineHeapMb;

  return {
    samples,
    baselineHeapMb,
    peakHeapMb,
    growthMb,
    slopeMbPerIter: Math.round(leastSquaresSlope(heapSeries) * 1000) / 1000,
  };
}
