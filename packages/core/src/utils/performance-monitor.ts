import { logger } from '../index';

interface PerformanceEntry {
  duration: number;
  timestamp: number;
}

interface PerformanceStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  total: number;
}

export class PerformanceMonitor {
  private metrics = new Map<string, PerformanceEntry[]>();
  private maxEntriesPerMetric: number;
  private cleanupIntervalMs: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    options: {
      maxEntriesPerMetric?: number;
      cleanupIntervalMs?: number;
    } = {}
  ) {
    this.maxEntriesPerMetric = options.maxEntriesPerMetric ?? 1000;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 300000;
    this.startCleanupTimer();
  }

  async measure<T>(
    label: string,
    fn: () => Promise<T> | T,
    context?: Record<string, unknown>
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const duration = performance.now() - start;
      this.record(label, duration, context);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.record(label, duration, { ...context, error: true });
      throw error;
    }
  }

  record(label: string, duration: number, context?: Record<string, unknown>): void {
    if (!this.metrics.has(label)) {
      this.metrics.set(label, []);
    }

    const entries = this.metrics.get(label)!;
    entries.push({
      duration,
      timestamp: Date.now(),
    });

    if (entries.length > this.maxEntriesPerMetric) {
      entries.shift();
    }

    if (duration > 1000) {
      logger.warn(
        {
          src: 'perf-monitor',
          label,
          duration: `${duration.toFixed(2)}ms`,
          ...context,
        },
        'Slow operation detected'
      );
    }
  }

  getStats(label: string): PerformanceStats | null {
    const entries = this.metrics.get(label);
    if (!entries || entries.length === 0) {
      return null;
    }

    const durations = entries.map((e) => e.duration).sort((a, b) => a - b);
    const count = durations.length;
    const total = durations.reduce((sum, d) => sum + d, 0);
    const avg = total / count;

    return {
      count,
      min: durations[0],
      max: durations[count - 1],
      avg,
      p50: durations[Math.floor(count * 0.5)],
      p95: durations[Math.floor(count * 0.95)],
      p99: durations[Math.floor(count * 0.99)],
      total,
    };
  }

  getAllStats(): Record<string, PerformanceStats> {
    const allStats: Record<string, PerformanceStats> = {};
    for (const label of this.metrics.keys()) {
      const stats = this.getStats(label);
      if (stats) {
        allStats[label] = stats;
      }
    }
    return allStats;
  }

  reset(label?: string): void {
    if (label) {
      this.metrics.delete(label);
    } else {
      this.metrics.clear();
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);
  }

  private cleanup(): void {
    const now = Date.now();
    const maxAge = 600000;

    for (const [label, entries] of this.metrics.entries()) {
      const filtered = entries.filter((e) => now - e.timestamp < maxAge);
      if (filtered.length === 0) {
        this.metrics.delete(label);
      } else {
        this.metrics.set(label, filtered);
      }
    }
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

export const perfMonitor = new PerformanceMonitor();
