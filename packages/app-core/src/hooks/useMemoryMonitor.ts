/**
 * Memory monitoring hook for detecting memory leaks.
 *
 * Uses the Performance API's memory metrics (Chrome/Edge only) to track
 * heap usage over time and detect potential memory leaks by analyzing
 * growth patterns.
 *
 * Usage:
 *   const { metrics, isLeaking, trend } = useMemoryMonitor({ enabled: true });
 *
 * The hook samples memory at regular intervals and calculates:
 * - Current heap usage
 * - Heap growth trend (MB/min)
 * - Leak detection based on sustained growth
 */

import { useCallback, useEffect, useRef, useState } from "react";

// Extend Performance interface for memory info (Chrome/Edge only)
interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: PerformanceMemory;
}

export interface MemoryMetrics {
  /** Current used JS heap size in bytes */
  usedHeapSize: number;
  /** Total JS heap size in bytes */
  totalHeapSize: number;
  /** JS heap size limit in bytes */
  heapSizeLimit: number;
  /** Heap usage as percentage of limit */
  usagePercent: number;
  /** Timestamp of measurement */
  timestamp: number;
}

export interface MemorySample {
  usedHeapSize: number;
  timestamp: number;
}

export interface MemoryTrend {
  /** Growth rate in bytes per minute (positive = growing) */
  bytesPerMinute: number;
  /** Growth rate in MB per minute */
  mbPerMinute: number;
  /** Number of samples in the analysis window */
  sampleCount: number;
  /** Duration of analysis window in minutes */
  windowMinutes: number;
}

export interface UseMemoryMonitorOptions {
  /** Enable memory monitoring (default: true in dev mode) */
  enabled?: boolean;
  /** Sampling interval in milliseconds (default: 5000) */
  sampleInterval?: number;
  /** Number of samples to keep for trend analysis (default: 60) */
  maxSamples?: number;
  /** Threshold in MB/min to consider a leak (default: 1.0) */
  leakThresholdMbPerMin?: number;
  /** Minimum samples before detecting leaks (default: 12) */
  minSamplesForDetection?: number;
  /** Callback when a potential leak is detected */
  onLeakDetected?: (trend: MemoryTrend, metrics: MemoryMetrics) => void;
}

export interface UseMemoryMonitorResult {
  /** Whether memory API is supported in this browser */
  supported: boolean;
  /** Current memory metrics (null if not supported) */
  metrics: MemoryMetrics | null;
  /** Memory growth trend analysis */
  trend: MemoryTrend | null;
  /** Whether a potential memory leak is detected */
  isLeaking: boolean;
  /** Historical samples for charting */
  samples: MemorySample[];
  /** Force garbage collection (if available) */
  forceGC: () => void;
  /** Clear sample history */
  clearHistory: () => void;
  /** Get formatted memory stats for display */
  getFormattedStats: () => string;
}

const DEFAULT_OPTIONS: Required<
  Omit<UseMemoryMonitorOptions, "onLeakDetected">
> = {
  enabled: Boolean(import.meta.env.DEV),
  sampleInterval: 5000,
  maxSamples: 60,
  leakThresholdMbPerMin: 1.0,
  minSamplesForDetection: 12,
};

function getMemoryInfo(): PerformanceMemory | null {
  const perf = performance as PerformanceWithMemory;
  return perf.memory ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function calculateTrend(samples: MemorySample[]): MemoryTrend | null {
  if (samples.length < 2) return null;

  const firstSample = samples[0];
  const lastSample = samples[samples.length - 1];
  const durationMs = lastSample.timestamp - firstSample.timestamp;

  if (durationMs <= 0) return null;

  const durationMinutes = durationMs / (1000 * 60);
  const heapChange = lastSample.usedHeapSize - firstSample.usedHeapSize;
  const bytesPerMinute = heapChange / durationMinutes;
  const mbPerMinute = bytesPerMinute / (1024 * 1024);

  return {
    bytesPerMinute,
    mbPerMinute,
    sampleCount: samples.length,
    windowMinutes: durationMinutes,
  };
}

export function useMemoryMonitor(
  options: UseMemoryMonitorOptions = {},
): UseMemoryMonitorResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const {
    enabled,
    sampleInterval,
    maxSamples,
    leakThresholdMbPerMin,
    minSamplesForDetection,
  } = opts;

  const [supported, setSupported] = useState(false);
  const [metrics, setMetrics] = useState<MemoryMetrics | null>(null);
  const [samples, setSamples] = useState<MemorySample[]>([]);
  const [trend, setTrend] = useState<MemoryTrend | null>(null);
  const [isLeaking, setIsLeaking] = useState(false);

  const onLeakDetectedRef = useRef(options.onLeakDetected);
  onLeakDetectedRef.current = options.onLeakDetected;
  const lastLeakNotifyRef = useRef(0);

  // Check browser support
  useEffect(() => {
    const memInfo = getMemoryInfo();
    setSupported(memInfo !== null);
  }, []);

  // Sample memory at intervals
  useEffect(() => {
    if (!enabled || !supported) return;

    const sample = () => {
      const memInfo = getMemoryInfo();
      if (!memInfo) return;

      const now = Date.now();
      const currentMetrics: MemoryMetrics = {
        usedHeapSize: memInfo.usedJSHeapSize,
        totalHeapSize: memInfo.totalJSHeapSize,
        heapSizeLimit: memInfo.jsHeapSizeLimit,
        usagePercent: (memInfo.usedJSHeapSize / memInfo.jsHeapSizeLimit) * 100,
        timestamp: now,
      };

      setMetrics(currentMetrics);

      setSamples((prev) => {
        const newSample: MemorySample = {
          usedHeapSize: memInfo.usedJSHeapSize,
          timestamp: now,
        };

        const updated = [...prev, newSample];
        if (updated.length > maxSamples) {
          updated.splice(0, updated.length - maxSamples);
        }
        return updated;
      });
    };

    // Initial sample
    sample();

    const intervalId = setInterval(sample, sampleInterval);
    return () => clearInterval(intervalId);
  }, [enabled, supported, sampleInterval, maxSamples]);

  // Calculate trend and detect leaks
  useEffect(() => {
    if (samples.length < 2) {
      setTrend(null);
      setIsLeaking(false);
      return;
    }

    const currentTrend = calculateTrend(samples);
    setTrend(currentTrend);

    if (!currentTrend || samples.length < minSamplesForDetection) {
      setIsLeaking(false);
      return;
    }

    // Detect sustained memory growth
    const leaking = currentTrend.mbPerMinute > leakThresholdMbPerMin;
    setIsLeaking(leaking);

    // Notify callback (throttled to once per minute)
    if (leaking && metrics && onLeakDetectedRef.current) {
      const now = Date.now();
      if (now - lastLeakNotifyRef.current > 60000) {
        lastLeakNotifyRef.current = now;
        onLeakDetectedRef.current(currentTrend, metrics);
      }
    }
  }, [samples, minSamplesForDetection, leakThresholdMbPerMin, metrics]);

  const forceGC = useCallback(() => {
    // gc() is only available when Chrome is started with --js-flags="--expose-gc"
    const win = window as Window & { gc?: () => void };
    if (typeof win.gc === "function") {
      win.gc();
    }
  }, []);

  const clearHistory = useCallback(() => {
    setSamples([]);
    setTrend(null);
    setIsLeaking(false);
  }, []);

  const getFormattedStats = useCallback(() => {
    if (!metrics) return "Memory monitoring not available";

    const lines = [
      `Heap Used: ${formatBytes(metrics.usedHeapSize)}`,
      `Heap Total: ${formatBytes(metrics.totalHeapSize)}`,
      `Heap Limit: ${formatBytes(metrics.heapSizeLimit)}`,
      `Usage: ${metrics.usagePercent.toFixed(1)}%`,
    ];

    if (trend) {
      const trendSign = trend.mbPerMinute >= 0 ? "+" : "";
      lines.push(
        `Trend: ${trendSign}${trend.mbPerMinute.toFixed(2)} MB/min`,
        `Samples: ${trend.sampleCount} (${trend.windowMinutes.toFixed(1)} min)`,
      );
    }

    if (isLeaking) {
      lines.push("WARNING: Potential memory leak detected!");
    }

    return lines.join("\n");
  }, [metrics, trend, isLeaking]);

  return {
    supported,
    metrics,
    trend,
    isLeaking,
    samples,
    forceGC,
    clearHistory,
    getFormattedStats,
  };
}

/**
 * Lightweight memory leak detector that logs warnings to console.
 * Can be used as a standalone function without React.
 */
export function startMemoryLeakDetector(options?: {
  intervalMs?: number;
  thresholdMbPerMin?: number;
  onLeak?: (info: { mbPerMinute: number; currentMb: number }) => void;
}): () => void {
  const intervalMs = options?.intervalMs ?? 10000;
  const thresholdMbPerMin = options?.thresholdMbPerMin ?? 2.0;
  const samples: MemorySample[] = [];
  const maxSamples = 30;

  const intervalId = setInterval(() => {
    const memInfo = getMemoryInfo();
    if (!memInfo) return;

    const now = Date.now();
    samples.push({
      usedHeapSize: memInfo.usedJSHeapSize,
      timestamp: now,
    });

    if (samples.length > maxSamples) {
      samples.shift();
    }

    if (samples.length >= 6) {
      const trend = calculateTrend(samples);
      if (trend && trend.mbPerMinute > thresholdMbPerMin) {
        const currentMb = memInfo.usedJSHeapSize / (1024 * 1024);
        console.warn(
          `[MemoryLeakDetector] Potential memory leak detected!\n` +
            `  Growth rate: +${trend.mbPerMinute.toFixed(2)} MB/min\n` +
            `  Current heap: ${currentMb.toFixed(1)} MB\n` +
            `  Window: ${trend.windowMinutes.toFixed(1)} min (${trend.sampleCount} samples)`,
        );
        options?.onLeak?.({
          mbPerMinute: trend.mbPerMinute,
          currentMb,
        });
      }
    }
  }, intervalMs);

  return () => clearInterval(intervalId);
}
