/**
 * JSON collector for pendant performance harnesses.
 *
 * The collector stores only contract marks, metrics, and counters so replay and
 * soak evidence remains machine-readable without transcript, audio, or device
 * identifiers.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  PendantLatencyMark,
  PendantLatencyMetric,
  PendantLatencySink,
} from "./pendant-latency";

export class PendantJsonMetricCollector implements PendantLatencySink {
  readonly marks: PendantLatencyMark[] = [];
  readonly metrics: PendantLatencyMetric[] = [];
  readonly counters: Record<string, number> = {};
  private readonly metricStats = new Map<string, OnlineMetricStats>();

  mark(mark: PendantLatencyMark): void {
    this.marks.push(mark);
    if (this.marks.length > 256) this.marks.shift();
  }

  metric(metric: PendantLatencyMetric): void {
    this.metrics.push(metric);
    if (this.metrics.length > 256) this.metrics.shift();
    const stats = this.metricStats.get(metric.name) ?? new OnlineMetricStats();
    stats.add(metric.valueMs);
    this.metricStats.set(metric.name, stats);
  }

  count(name: string, value: number): void {
    this.counters[name] = (this.counters[name] ?? 0) + value;
  }

  summarize(): Record<
    string,
    { count: number; p50: number; p95: number; max: number }
  > {
    const out: Record<
      string,
      { count: number; p50: number; p95: number; max: number }
    > = {};
    for (const [name, stats] of this.metricStats) {
      out[name] = stats.summary();
    }
    return out;
  }
}

class OnlineMetricStats {
  private readonly sample: number[] = [];
  private count = 0;
  private max = 0;

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    this.count += 1;
    this.max = Math.max(this.max, value);
    if (this.sample.length < 1024) {
      this.sample.push(value);
      return;
    }
    // Keep a deterministic rolling window. This makes a long soak's p50/p95
    // represent its most recent steady state while memory remains fixed.
    this.sample[(this.count - 1) % this.sample.length] = value;
  }

  summary(): { count: number; p50: number; p95: number; max: number } {
    const sorted = [...this.sample].sort((a, b) => a - b);
    return {
      count: this.count,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: this.max,
    };
  }
}

export function hostInfo(): {
  runtime: string;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  cpus: number;
} {
  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun
    ?.version;
  return {
    runtime: bunVersion ? `bun ${bunVersion}` : "node",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: navigator.hardwareConcurrency ?? 1,
  };
}

export function writeJsonReport(
  path: string | undefined,
  report: unknown,
): void {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (!path) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * q) - 1),
  );
  return values[index] ?? 0;
}
