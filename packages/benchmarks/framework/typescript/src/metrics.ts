/**
 * Performance Metrics Collection Utilities
 *
 * Provides high-resolution timing, memory monitoring, and statistical
 * aggregation for benchmark measurements.
 */
import { cpus, totalmem, platform, arch, release } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LatencyStats {
  min_ms: number;
  max_ms: number;
  avg_ms: number;
  median_ms: number;
  p95_ms: number;
  p99_ms: number;
  stddev_ms: number;
  raw_ms: number[];
}

export interface ThroughputStats {
  messages_per_second: number;
  total_messages: number;
  total_time_ms: number;
}

export interface PipelineBreakdown {
  compose_state_avg_ms: number;
  provider_execution_avg_ms: number;
  should_respond_avg_ms: number;
  model_call_avg_ms: number;
  action_dispatch_avg_ms: number;
  evaluator_avg_ms: number;
  memory_create_avg_ms: number;
  memory_get_avg_ms: number;
  /** Total time spent in model calls (only meaningful in real-LLM mode) */
  model_time_total_ms: number;
  /** Estimated framework-only time: total - model_time (only meaningful in real-LLM mode) */
  framework_time_total_ms: number;
}

export interface ResourceStats {
  memory_rss_start_mb: number;
  memory_rss_peak_mb: number;
  memory_rss_end_mb: number;
  memory_delta_mb: number;
  heap_used_start_mb: number;
  heap_used_peak_mb: number;
  heap_used_end_mb: number;
}

export interface ScenarioResult {
  iterations: number;
  warmup: number;
  latency: LatencyStats;
  throughput: ThroughputStats;
  pipeline: PipelineBreakdown;
  resources: ResourceStats;
}

export interface SystemInfo {
  os: string;
  arch: string;
  cpus: number;
  memory_gb: number;
  runtime_version: string;
  platform: string;
}

export interface BenchmarkResult {
  runtime: "typescript" | "python" | "rust";
  timestamp: string;
  system: SystemInfo;
  scenarios: Record<string, ScenarioResult>;
  binary_size_bytes?: number;
}

// ─── High-resolution timer ──────────────────────────────────────────────────

export class Timer {
  private startTime = 0;
  private endTime = 0;

  start(): void {
    this.startTime = performance.now();
  }

  stop(): number {
    this.endTime = performance.now();
    return this.elapsed();
  }

  elapsed(): number {
    return this.endTime - this.startTime;
  }
}

// ─── Memory monitor ─────────────────────────────────────────────────────────

export class MemoryMonitor {
  private peakRss = 0;
  private peakHeap = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private startRss = 0;
  private startHeap = 0;

  start(): void {
    const mem = process.memoryUsage();
    this.startRss = mem.rss;
    this.startHeap = mem.heapUsed;
    this.peakRss = mem.rss;
    this.peakHeap = mem.heapUsed;

    // Poll every 10ms for peak measurement
    this.intervalId = setInterval(() => {
      const current = process.memoryUsage();
      if (current.rss > this.peakRss) this.peakRss = current.rss;
      if (current.heapUsed > this.peakHeap) this.peakHeap = current.heapUsed;
    }, 10);
  }

  stop(): ResourceStats {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    const mem = process.memoryUsage();
    // Check one final time
    if (mem.rss > this.peakRss) this.peakRss = mem.rss;
    if (mem.heapUsed > this.peakHeap) this.peakHeap = mem.heapUsed;

    return {
      memory_rss_start_mb: this.startRss / (1024 * 1024),
      memory_rss_peak_mb: this.peakRss / (1024 * 1024),
      memory_rss_end_mb: mem.rss / (1024 * 1024),
      memory_delta_mb: (mem.rss - this.startRss) / (1024 * 1024),
      heap_used_start_mb: this.startHeap / (1024 * 1024),
      heap_used_peak_mb: this.peakHeap / (1024 * 1024),
      heap_used_end_mb: mem.heapUsed / (1024 * 1024),
    };
  }
}

// ─── Pipeline instrumentation ───────────────────────────────────────────────

export class PipelineTimer {
  private timings: Record<string, number[]> = {
    compose_state: [],
    provider_execution: [],
    should_respond: [],
    model_call: [],
    action_dispatch: [],
    evaluator: [],
    memory_create: [],
    memory_get: [],
  };

  record(category: string, durationMs: number): void {
    if (!this.timings[category]) {
      this.timings[category] = [];
    }
    this.timings[category].push(durationMs);
  }

  getBreakdown(): PipelineBreakdown {
    const avg = (arr: number[]): number =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const total = (arr: number[]): number =>
      arr.reduce((a, b) => a + b, 0);

    const modelTimeTotal = total(this.timings.model_call);

    return {
      compose_state_avg_ms: avg(this.timings.compose_state),
      provider_execution_avg_ms: avg(this.timings.provider_execution),
      should_respond_avg_ms: avg(this.timings.should_respond),
      model_call_avg_ms: avg(this.timings.model_call),
      action_dispatch_avg_ms: avg(this.timings.action_dispatch),
      evaluator_avg_ms: avg(this.timings.evaluator),
      memory_create_avg_ms: avg(this.timings.memory_create),
      memory_get_avg_ms: avg(this.timings.memory_get),
      model_time_total_ms: modelTimeTotal,
      framework_time_total_ms: 0, // Will be computed by the caller with wall-clock total
    };
  }

  reset(): void {
    for (const key of Object.keys(this.timings)) {
      this.timings[key] = [];
    }
  }
}

// ─── Statistics ─────────────────────────────────────────────────────────────

export function computeLatencyStats(rawMs: number[]): LatencyStats {
  if (rawMs.length === 0) {
    return {
      min_ms: 0,
      max_ms: 0,
      avg_ms: 0,
      median_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      stddev_ms: 0,
      raw_ms: [],
    };
  }

  const sorted = [...rawMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;

  const variance =
    sorted.reduce((acc, val) => acc + (val - avg) ** 2, 0) / sorted.length;
  const stddev = Math.sqrt(variance);

  return {
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
    avg_ms: avg,
    median_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    stddev_ms: stddev,
    raw_ms: rawMs,
  };
}

function percentile(sorted: number[], pct: number): number {
  const idx = (pct / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function computeThroughputStats(
  totalMessages: number,
  totalTimeMs: number,
): ThroughputStats {
  return {
    messages_per_second: totalTimeMs > 0 ? (totalMessages / totalTimeMs) * 1000 : 0,
    total_messages: totalMessages,
    total_time_ms: totalTimeMs,
  };
}

// ─── System info ────────────────────────────────────────────────────────────

export function getSystemInfo(): SystemInfo {
  const cpuInfo = cpus();
  return {
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpus: cpuInfo.length,
    memory_gb: Math.round((totalmem() / (1024 * 1024 * 1024)) * 10) / 10,
    runtime_version: `Bun ${Bun.version}`,
    platform: "typescript",
  };
}

// ─── Pretty print ───────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function printScenarioResult(scenarioId: string, result: ScenarioResult, realLlm: boolean = false): void {
  console.log(`\n  ${scenarioId}`);
  console.log(`    Iterations: ${result.iterations} (warmup: ${result.warmup})`);
  console.log(`    Latency:  avg=${formatDuration(result.latency.avg_ms)}  median=${formatDuration(result.latency.median_ms)}  p95=${formatDuration(result.latency.p95_ms)}  p99=${formatDuration(result.latency.p99_ms)}`);
  console.log(`    Range:    min=${formatDuration(result.latency.min_ms)}  max=${formatDuration(result.latency.max_ms)}  stddev=${formatDuration(result.latency.stddev_ms)}`);
  console.log(`    Throughput: ${result.throughput.messages_per_second.toFixed(1)} msg/s (${result.throughput.total_messages} messages in ${formatDuration(result.throughput.total_time_ms)})`);
  console.log(`    Memory:   start=${result.resources.memory_rss_start_mb.toFixed(1)}MB  peak=${result.resources.memory_rss_peak_mb.toFixed(1)}MB  delta=${result.resources.memory_delta_mb.toFixed(1)}MB`);
  console.log(`    Pipeline: state=${formatDuration(result.pipeline.compose_state_avg_ms)}  model=${formatDuration(result.pipeline.model_call_avg_ms)}  actions=${formatDuration(result.pipeline.action_dispatch_avg_ms)}  memory=${formatDuration(result.pipeline.memory_create_avg_ms)}`);
  if (realLlm && result.pipeline.model_time_total_ms > 0) {
    console.log(`    Timing:   model_total=${formatDuration(result.pipeline.model_time_total_ms)}  framework_total=${formatDuration(result.pipeline.framework_time_total_ms)}`);
  }
}
