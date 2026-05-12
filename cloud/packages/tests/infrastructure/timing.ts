/**
 * Timing Utilities for Test Infrastructure
 *
 * Simple timing utilities for measuring performance in tests.
 */

const timers = new Map<string, number>();

/**
 * Start a named timer
 */
export function startTimer(name: string): void {
  timers.set(name, Date.now());
}

/**
 * End a named timer and return the duration in milliseconds
 */
export function endTimer(name: string): number {
  const startTime = timers.get(name);
  if (!startTime) {
    console.warn(`[Timing] Timer "${name}" was not started`);
    return 0;
  }
  timers.delete(name);
  return Date.now() - startTime;
}

/**
 * Log a set of timings with a label
 */
export function logTimings(label: string, timings: Record<string, number>): void {
  console.log(`\n[Timings] ${label}:`);

  const entries = Object.entries(timings).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, ms]) => sum + ms, 0);

  for (const [name, ms] of entries) {
    const pct = total > 0 ? ((ms / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${name}: ${ms}ms (${pct}%)`);
  }

  console.log(`  TOTAL: ${total}ms\n`);
}

/**
 * Create a scoped timer that auto-logs on completion
 */
export function createScopedTimer(label: string): {
  mark: (name: string) => void;
  end: () => Record<string, number>;
} {
  const timings: Record<string, number> = {};
  let lastMark = Date.now();

  return {
    mark(name: string) {
      const now = Date.now();
      timings[name] = now - lastMark;
      lastMark = now;
    },
    end() {
      logTimings(label, timings);
      return timings;
    },
  };
}

/**
 * Timer class for basic timing operations
 */
export class Timer {
  private name: string;
  private startTime: number;

  constructor(name: string) {
    this.name = name;
    this.startTime = Date.now();
  }

  stop(): { name: string; durationMs: number } {
    const durationMs = Date.now() - this.startTime;
    return { name: this.name, durationMs };
  }
}

/**
 * High-resolution timer using performance.now()
 */
export class HRTimer {
  private name: string;
  private startTime: number;

  constructor(name: string) {
    this.name = name;
    this.startTime = performance.now();
  }

  stop(): { name: string; durationMs: number } {
    const durationMs = performance.now() - this.startTime;
    return { name: this.name, durationMs };
  }
}

/**
 * Timing collector for aggregating multiple timing measurements
 */
export class TimingCollector {
  private timings: Map<
    string,
    {
      startTime: number;
      results: Array<{
        durationMs: number;
        metadata?: Record<string, unknown>;
      }>;
    }
  > = new Map();

  start(name: string): void {
    if (!this.timings.has(name)) {
      this.timings.set(name, { startTime: Date.now(), results: [] });
    } else {
      const timing = this.timings.get(name)!;
      timing.startTime = Date.now();
    }
  }

  stop(name: string, metadata?: Record<string, unknown>): number {
    const timing = this.timings.get(name);
    if (!timing) {
      console.warn(`[TimingCollector] Timer "${name}" was not started`);
      return 0;
    }
    const durationMs = Date.now() - timing.startTime;
    timing.results.push({ durationMs, metadata });
    return durationMs;
  }

  getResults(name: string): Array<{ durationMs: number; metadata?: Record<string, unknown> }> {
    return this.timings.get(name)?.results || [];
  }

  getAverage(name: string): number {
    const results = this.getResults(name);
    if (results.length === 0) return 0;
    return results.reduce((sum, r) => sum + r.durationMs, 0) / results.length;
  }

  printSummary(): void {
    console.log("\n[TimingCollector] Summary:");
    for (const [name, timing] of this.timings) {
      const avg = timing.results.reduce((sum, r) => sum + r.durationMs, 0) / timing.results.length;
      const min = Math.min(...timing.results.map((r) => r.durationMs));
      const max = Math.max(...timing.results.map((r) => r.durationMs));
      console.log(
        `  ${name}: avg=${avg.toFixed(1)}ms, min=${min.toFixed(1)}ms, max=${max.toFixed(1)}ms (${timing.results.length} runs)`,
      );
    }
    console.log("");
  }

  clear(): void {
    this.timings.clear();
  }
}

const timing = {
  startTimer,
  endTimer,
  logTimings,
  createScopedTimer,
  Timer,
  HRTimer,
  TimingCollector,
};

export default timing;
