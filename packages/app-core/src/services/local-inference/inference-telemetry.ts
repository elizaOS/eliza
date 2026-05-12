/**
 * Lightweight structured-metrics sink for local-inference telemetry.
 *
 * This module is intentionally small: it is a logger-backed histogram with a
 * stable, call-site-friendly `record(name, value, tags?)` API so individual
 * backends (dflash-server, voice scheduler, …) can emit point-in-time
 * observations without importing a heavy metrics framework.
 *
 * Design constraints
 * ------------------
 * - No external dependencies beyond `@elizaos/core` logger (already a dep).
 * - `record()` is synchronous and must never throw into the call site.
 * - Each named metric keeps a bounded ring of recent samples (default 256) for
 *   in-process p50/p95 queries via `summary(name)`. This mirrors the
 *   `BoundedHistogram` pattern already used by `latency-trace.ts`.
 * - The module exports a process-wide singleton (`inferenceTelemetry`) that
 *   all backends share, plus the class for test injection.
 *
 * Metric names used today
 * -----------------------
 *   inference.ttfa_ms        — time from fetch() to first HTTP chunk (L5)
 *   inference.first_token_ms — time from fetch() to first decoded token (L5)
 *   tts.chunk_size_ms        — duration of one PCM chunk in ms (T2)
 *   tts.chunk_size_bytes     — byte size of one PCM chunk (T2)
 */

import { logger } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Bounded histogram (copied structure from latency-trace.ts — same project)
// ---------------------------------------------------------------------------

interface HistogramSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  mean: number | null;
}

class BoundedRing {
  private readonly buf: number[];
  private head = 0;
  private filled = 0;

  constructor(private readonly cap: number) {
    this.buf = new Array<number>(cap).fill(0);
  }

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.filled < this.cap) this.filled += 1;
  }

  summary(): HistogramSummary {
    if (this.filled === 0)
      return { count: 0, p50: null, p95: null, mean: null };
    const slice = this.buf.slice(0, this.filled).sort((a, b) => a - b);
    const pct = (q: number): number => {
      const rank = Math.ceil((q / 100) * slice.length);
      return slice[Math.min(slice.length - 1, Math.max(0, rank - 1))] as number;
    };
    const sum = slice.reduce((a, b) => a + b, 0);
    return {
      count: this.filled,
      p50: pct(50),
      p95: pct(95),
      mean: sum / this.filled,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type TelemetryTags = Record<string, string | number | boolean>;

export class InferenceTelemetry {
  private readonly rings = new Map<string, BoundedRing>();
  private readonly capacity: number;

  constructor(capacity = 256) {
    this.capacity = capacity;
  }

  /**
   * Record a scalar observation. Never throws — telemetry must be
   * instrumentation, never a fault path.
   *
   * @param name  Dot-separated metric name, e.g. `"inference.ttfa_ms"`.
   * @param value Numeric value (non-finite values are silently dropped).
   * @param tags  Optional key/value labels emitted in the log line.
   */
  record(name: string, value: number, tags?: TelemetryTags): void {
    try {
      let ring = this.rings.get(name);
      if (!ring) {
        ring = new BoundedRing(this.capacity);
        this.rings.set(name, ring);
      }
      ring.push(value);
      const tagStr = tags
        ? " " +
          Object.entries(tags)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
      logger.debug(`[InferenceTelemetry] ${name}=${value}${tagStr}`);
    } catch {
      // Swallow — telemetry must never surface as a runtime error.
    }
  }

  /**
   * Summary statistics for a named metric over the retained ring of samples.
   * Returns `{ count: 0, ... }` when the metric has never been recorded.
   */
  summary(name: string): HistogramSummary {
    return this.rings.get(name)?.summary() ?? { count: 0, p50: null, p95: null, mean: null };
  }

  /** Names of all metrics that have received at least one sample. */
  metricNames(): string[] {
    return [...this.rings.keys()];
  }

  /** Reset all retained samples. Useful in tests. */
  reset(): void {
    this.rings.clear();
  }
}

/** Process-wide singleton used by dflash-server and voice scheduler. */
export const inferenceTelemetry = new InferenceTelemetry();
