import { OHLCV } from '../types.ts';

/**
 * Performance optimization utilities for handling large historical datasets
 */

export interface BatchProcessor<T, R> {
  process(batch: T[]): Promise<R[]>;
  batchSize: number;
}

export interface StreamingIndicator {
  update(candle: OHLCV): void;
  getValue(): number | undefined;
  reset(): void;
}

/**
 * Efficient batch processing for large datasets
 */
export class BatchDataProcessor {
  /**
   * Process data in batches to avoid memory overflow
   */
  static async processBatches<T, R>(
    data: T[],
    processor: BatchProcessor<T, R>,
    options?: {
      maxConcurrency?: number;
      onProgress?: (processed: number, total: number) => void;
    }
  ): Promise<R[]> {
    const { maxConcurrency = 3, onProgress } = options || {};
    const results: R[] = [];
    const batchSize = processor.batchSize;

    let processed = 0;
    const totalBatches = Math.ceil(data.length / batchSize);

    // Process batches with concurrency control
    for (let i = 0; i < data.length; i += batchSize * maxConcurrency) {
      const batchPromises: Promise<R[]>[] = [];

      for (let j = 0; j < maxConcurrency && i + j * batchSize < data.length; j++) {
        const start = i + j * batchSize;
        const end = Math.min(start + batchSize, data.length);
        const batch = data.slice(start, end);

        batchPromises.push(processor.process(batch));
      }

      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach((res) => results.push(...res));

      processed += batchPromises.length;
      if (onProgress) {
        onProgress(processed * batchSize, data.length);
      }
    }

    return results;
  }
}

/**
 * Memory-efficient streaming RSI calculator
 */
export class StreamingRSI implements StreamingIndicator {
  private period: number;
  private gains: number[] = [];
  private losses: number[] = [];
  private lastClose?: number;
  private avgGain?: number;
  private avgLoss?: number;
  private count = 0;

  constructor(period: number = 14) {
    this.period = period;
  }

  update(candle: OHLCV): void {
    if (this.lastClose !== undefined) {
      const change = candle.close - this.lastClose;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;

      if (this.count < this.period) {
        this.gains.push(gain);
        this.losses.push(loss);
        this.count++;

        if (this.count === this.period) {
          this.avgGain = this.gains.reduce((a, b) => a + b, 0) / this.period;
          this.avgLoss = this.losses.reduce((a, b) => a + b, 0) / this.period;
        }
      } else {
        // Use smoothed averages (Wilder's method)
        this.avgGain = (this.avgGain! * (this.period - 1) + gain) / this.period;
        this.avgLoss = (this.avgLoss! * (this.period - 1) + loss) / this.period;
      }
    }

    this.lastClose = candle.close;
  }

  getValue(): number | undefined {
    if (!this.avgGain || !this.avgLoss || this.count < this.period) {
      return undefined;
    }

    if (this.avgLoss === 0) {
      return 100;
    }

    const rs = this.avgGain / this.avgLoss;
    return 100 - 100 / (1 + rs);
  }

  reset(): void {
    this.gains = [];
    this.losses = [];
    this.lastClose = undefined;
    this.avgGain = undefined;
    this.avgLoss = undefined;
    this.count = 0;
  }
}

/**
 * Memory-efficient streaming EMA calculator
 */
export class StreamingEMA implements StreamingIndicator {
  private period: number;
  private multiplier: number;
  private ema?: number;
  private count = 0;
  private sum = 0;

  constructor(period: number) {
    this.period = period;
    this.multiplier = 2 / (period + 1);
  }

  update(candle: OHLCV): void {
    if (this.count < this.period) {
      this.sum += candle.close;
      this.count++;

      if (this.count === this.period) {
        this.ema = this.sum / this.period;
      }
    } else {
      this.ema = candle.close * this.multiplier + this.ema! * (1 - this.multiplier);
    }
  }

  getValue(): number | undefined {
    return this.ema;
  }

  reset(): void {
    this.ema = undefined;
    this.count = 0;
    this.sum = 0;
  }
}

/**
 * Memory-efficient data windowing for large datasets
 */
export class SlidingWindow<T> {
  private buffer: T[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getWindow(): T[] {
    return [...this.buffer];
  }

  isFull(): boolean {
    return this.buffer.length === this.maxSize;
  }

  clear(): void {
    this.buffer = [];
  }
}

/**
 * Optimized data aggregator for different timeframes
 */
export class TimeframeAggregator {
  /**
   * Aggregate 1-minute candles into higher timeframes
   */
  static aggregate(candles: OHLCV[], targetMinutes: number): OHLCV[] {
    if (targetMinutes <= 1) {
      return candles;
    }

    const aggregated: OHLCV[] = [];
    let currentGroup: OHLCV[] = [];

    for (const candle of candles) {
      currentGroup.push(candle);

      // Check if we've collected enough candles for the target timeframe
      if (currentGroup.length >= targetMinutes) {
        const aggregatedCandle: OHLCV = {
          timestamp: currentGroup[0].timestamp,
          open: currentGroup[0].open,
          high: Math.max(...currentGroup.map((c) => c.high)),
          low: Math.min(...currentGroup.map((c) => c.low)),
          close: currentGroup[currentGroup.length - 1].close,
          volume: currentGroup.reduce((sum, c) => sum + c.volume, 0),
        };

        aggregated.push(aggregatedCandle);
        currentGroup = [];
      }
    }

    return aggregated;
  }
}

/**
 * Cache manager for frequently accessed data
 */
export class DataCache<K, V> {
  private cache: Map<K, { value: V; timestamp: number }> = new Map();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number = 1000, ttlMs: number = 3600000) {
    // 1 hour default TTL
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  set(key: K, value: V): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = Array.from(this.cache.entries()).sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      )[0][0];
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, { value, timestamp: Date.now() });
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    // Check if entry has expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Performance metrics tracker
 */
export class PerformanceTracker {
  private metrics: Map<string, number[]> = new Map();

  startTimer(operation: string): () => void {
    const start = process.hrtime.bigint();

    return () => {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;

      if (!this.metrics.has(operation)) {
        this.metrics.set(operation, []);
      }

      this.metrics.get(operation)!.push(durationMs);
    };
  }

  getMetrics(operation: string): {
    count: number;
    avgMs: number;
    minMs: number;
    maxMs: number;
  } | null {
    const times = this.metrics.get(operation);
    if (!times || times.length === 0) {
      return null;
    }

    return {
      count: times.length,
      avgMs: times.reduce((a, b) => a + b, 0) / times.length,
      minMs: Math.min(...times),
      maxMs: Math.max(...times),
    };
  }

  logMetrics(): void {
    console.log('\n=== Performance Metrics ===');
    for (const [operation, times] of this.metrics.entries()) {
      const metrics = this.getMetrics(operation);
      if (metrics) {
        console.log(`${operation}:`);
        console.log(`  Count: ${metrics.count}`);
        console.log(`  Avg: ${metrics.avgMs.toFixed(2)}ms`);
        console.log(`  Min: ${metrics.minMs.toFixed(2)}ms`);
        console.log(`  Max: ${metrics.maxMs.toFixed(2)}ms`);
      }
    }
  }

  reset(): void {
    this.metrics.clear();
  }
}
