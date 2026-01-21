/**
 * Comprehensive Performance Monitoring System
 *
 * Tracks:
 * - Redis cache performance (hit/miss rates, latency)
 * - Database query performance (operations, CPU impact)
 * - Storage operations (MinIO/Vercel Blob)
 * - Memory and CPU usage
 * - Vercel cache effectiveness
 */

import { logger } from "@polyagent/shared";

interface CacheMetrics {
  hits: number;
  misses: number;
  avgLatencyMs: number;
  operations: {
    get: number;
    set: number;
    delete: number;
  };
  bytesRead: number;
  bytesWritten: number;
}

interface StorageMetrics {
  uploads: number;
  downloads: number;
  deletes: number;
  bytesUploaded: number;
  bytesDownloaded: number;
  avgUploadLatencyMs: number;
  avgDownloadLatencyMs: number;
  errors: number;
}

interface DatabaseMetrics {
  queries: number;
  slowQueries: number;
  avgDurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  operationBreakdown: Record<
    string,
    {
      count: number;
      avgDuration: number;
      maxDuration: number;
      cpuIntensive: boolean;
    }
  >;
  connectionPoolStats: {
    active: number;
    idle: number;
    waiting: number;
  };
}

interface SystemMetrics {
  cpuUsagePercent: number;
  memoryUsageMB: number;
  memoryUsagePercent: number;
  uptimeSeconds: number;
  activeRequests: number;
  requestsPerSecond: number;
}

interface PerformanceSnapshot {
  timestamp: Date;
  cache: CacheMetrics;
  storage: StorageMetrics;
  database: DatabaseMetrics;
  system: SystemMetrics;
  vercelCache?: {
    hits: number;
    misses: number;
    hitRate: number;
  };
}

class PerformanceMonitor {
  private snapshots: PerformanceSnapshot[] = [];
  private readonly MAX_SNAPSHOTS = 1000;

  // Cache metrics
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheLatencies: number[] = [];
  private cacheOps = { get: 0, set: 0, delete: 0 };
  private cacheBytesRead = 0;
  private cacheBytesWritten = 0;

  // Storage metrics
  private storageUploads = 0;
  private storageDownloads = 0;
  private storageDeletes = 0;
  private storageBytesUp = 0;
  private storageBytesDown = 0;
  private storageUploadLatencies: number[] = [];
  private storageDownloadLatencies: number[] = [];
  private storageErrors = 0;

  // Database metrics (extended from query monitor)
  private dbOperations: Map<
    string,
    {
      count: number;
      totalDuration: number;
      maxDuration: number;
      durations: number[];
      cpuIntensive: boolean;
    }
  > = new Map();

  // System metrics
  private requestCount = 0;
  private activeRequests = 0;

  // Vercel cache metrics
  private vercelCacheHits = 0;
  private vercelCacheMisses = 0;

  /**
   * Record a cache operation
   */
  recordCacheOperation(
    operation: "get" | "set" | "delete",
    hit: boolean,
    latencyMs: number,
    bytes?: number,
  ): void {
    this.cacheOps[operation]++;

    if (operation === "get") {
      if (hit) {
        this.cacheHits++;
        if (bytes) this.cacheBytesRead += bytes;
      } else {
        this.cacheMisses++;
      }
      this.cacheLatencies.push(latencyMs);
    } else if (operation === "set" && bytes) {
      this.cacheBytesWritten += bytes;
    }
  }

  /**
   * Record a storage operation
   */
  recordStorageOperation(
    operation: "upload" | "download" | "delete",
    latencyMs: number,
    bytes?: number,
    error?: boolean,
  ): void {
    if (error) {
      this.storageErrors++;
      return;
    }

    switch (operation) {
      case "upload":
        this.storageUploads++;
        this.storageUploadLatencies.push(latencyMs);
        if (bytes) this.storageBytesUp += bytes;
        break;
      case "download":
        this.storageDownloads++;
        this.storageDownloadLatencies.push(latencyMs);
        if (bytes) this.storageBytesDown += bytes;
        break;
      case "delete":
        this.storageDeletes++;
        break;
    }
  }

  /**
   * Record a database operation
   */
  recordDatabaseOperation(
    model: string,
    operation: string,
    durationMs: number,
    cpuIntensive = false,
  ): void {
    const key = `${model}.${operation}`;
    const existing = this.dbOperations.get(key);

    if (existing) {
      existing.count++;
      existing.totalDuration += durationMs;
      existing.maxDuration = Math.max(existing.maxDuration, durationMs);
      existing.durations.push(durationMs);
      existing.cpuIntensive = existing.cpuIntensive || cpuIntensive;
    } else {
      this.dbOperations.set(key, {
        count: 1,
        totalDuration: durationMs,
        maxDuration: durationMs,
        durations: [durationMs],
        cpuIntensive,
      });
    }
  }

  /**
   * Record request start/end
   */
  startRequest(): void {
    this.activeRequests++;
    this.requestCount++;
  }

  endRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  /**
   * Record Vercel cache hit/miss
   */
  recordVercelCache(hit: boolean): void {
    if (hit) {
      this.vercelCacheHits++;
    } else {
      this.vercelCacheMisses++;
    }
  }

  /**
   * Take a performance snapshot
   */
  takeSnapshot(): PerformanceSnapshot {
    // Check if process methods are available (not available in browser environments)
    const hasMemoryUsage =
      typeof process !== "undefined" &&
      typeof process.memoryUsage === "function";
    const hasCpuUsage =
      typeof process !== "undefined" && typeof process.cpuUsage === "function";
    const hasUptime =
      typeof process !== "undefined" && typeof process.uptime === "function";

    const memUsage = hasMemoryUsage
      ? process.memoryUsage()
      : { heapUsed: 0, heapTotal: 0, rss: 0, external: 0, arrayBuffers: 0 };
    const uptime = hasUptime ? process.uptime() : 0;

    // Calculate database metrics
    const dbOperationBreakdown: Record<
      string,
      {
        count: number;
        avgDuration: number;
        maxDuration: number;
        cpuIntensive: boolean;
      }
    > = {};

    let totalDbDuration = 0;
    let totalDbQueries = 0;
    let slowDbQueries = 0;
    const allDbDurations: number[] = [];

    for (const [key, stats] of this.dbOperations.entries()) {
      dbOperationBreakdown[key] = {
        count: stats.count,
        avgDuration: stats.totalDuration / stats.count,
        maxDuration: stats.maxDuration,
        cpuIntensive: stats.cpuIntensive,
      };

      totalDbDuration += stats.totalDuration;
      totalDbQueries += stats.count;
      slowDbQueries += stats.durations.filter((d) => d > 100).length;
      allDbDurations.push(...stats.durations);
    }

    // Sort durations for percentiles
    allDbDurations.sort((a, b) => a - b);
    const p95Index = Math.floor(allDbDurations.length * 0.95);
    const p99Index = Math.floor(allDbDurations.length * 0.99);

    // Calculate request rate
    const timeWindowSeconds = Math.min(60, uptime);
    const requestsPerSecond = this.requestCount / timeWindowSeconds;

    const snapshot: PerformanceSnapshot = {
      timestamp: new Date(),
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        avgLatencyMs:
          this.cacheLatencies.length > 0
            ? this.cacheLatencies.reduce((a, b) => a + b, 0) /
              this.cacheLatencies.length
            : 0,
        operations: { ...this.cacheOps },
        bytesRead: this.cacheBytesRead,
        bytesWritten: this.cacheBytesWritten,
      },
      storage: {
        uploads: this.storageUploads,
        downloads: this.storageDownloads,
        deletes: this.storageDeletes,
        bytesUploaded: this.storageBytesUp,
        bytesDownloaded: this.storageBytesDown,
        avgUploadLatencyMs:
          this.storageUploadLatencies.length > 0
            ? this.storageUploadLatencies.reduce((a, b) => a + b, 0) /
              this.storageUploadLatencies.length
            : 0,
        avgDownloadLatencyMs:
          this.storageDownloadLatencies.length > 0
            ? this.storageDownloadLatencies.reduce((a, b) => a + b, 0) /
              this.storageDownloadLatencies.length
            : 0,
        errors: this.storageErrors,
      },
      database: {
        queries: totalDbQueries,
        slowQueries: slowDbQueries,
        avgDurationMs:
          totalDbQueries > 0 ? totalDbDuration / totalDbQueries : 0,
        p95DurationMs: allDbDurations[p95Index] || 0,
        p99DurationMs: allDbDurations[p99Index] || 0,
        operationBreakdown: dbOperationBreakdown,
        connectionPoolStats: {
          active: 0, // Would need to hook into database for this
          idle: 0,
          waiting: 0,
        },
      },
      system: {
        cpuUsagePercent: hasCpuUsage ? process.cpuUsage().user / 1000000 : 0, // Convert to percentage, default to 0 in browser
        memoryUsageMB: memUsage.heapUsed / 1024 / 1024,
        memoryUsagePercent:
          memUsage.heapTotal > 0
            ? Math.min((memUsage.heapUsed / memUsage.heapTotal) * 100, 100)
            : 0, // Cap at 100%, default to 0 if heapTotal is 0
        uptimeSeconds: uptime,
        activeRequests: this.activeRequests,
        requestsPerSecond,
      },
    };

    // Add Vercel cache stats if available
    if (this.vercelCacheHits + this.vercelCacheMisses > 0) {
      const total = this.vercelCacheHits + this.vercelCacheMisses;
      snapshot.vercelCache = {
        hits: this.vercelCacheHits,
        misses: this.vercelCacheMisses,
        hitRate: this.vercelCacheHits / total,
      };
    }

    // Store snapshot
    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }

    return snapshot;
  }

  /**
   * Get performance statistics
   */
  getStats(): PerformanceSnapshot {
    return this.takeSnapshot();
  }

  /**
   * Get all snapshots
   */
  getSnapshots(): PerformanceSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Get cache hit rate
   */
  getCacheHitRate(): number {
    const total = this.cacheHits + this.cacheMisses;
    return total > 0 ? this.cacheHits / total : 0;
  }

  /**
   * Identify bottlenecks
   */
  identifyBottlenecks(): {
    type: "cache" | "database" | "storage" | "memory" | "cpu";
    severity: "critical" | "warning" | "info";
    description: string;
    metric: number;
    threshold: number;
  }[] {
    const snapshot = this.takeSnapshot();
    const bottlenecks: ReturnType<PerformanceMonitor["identifyBottlenecks"]> =
      [];

    // Check cache hit rate
    const cacheTotal = snapshot.cache.hits + snapshot.cache.misses;
    if (cacheTotal > 0) {
      const hitRate = snapshot.cache.hits / cacheTotal;
      if (hitRate < 0.5) {
        bottlenecks.push({
          type: "cache",
          severity: "critical",
          description: "Low cache hit rate - consider caching more data",
          metric: hitRate,
          threshold: 0.5,
        });
      } else if (hitRate < 0.8) {
        bottlenecks.push({
          type: "cache",
          severity: "warning",
          description: "Moderate cache hit rate - optimization possible",
          metric: hitRate,
          threshold: 0.8,
        });
      }
    }

    // Check database performance
    if (snapshot.database.p95DurationMs > 200) {
      bottlenecks.push({
        type: "database",
        severity: "critical",
        description: "Slow database queries - P95 > 200ms",
        metric: snapshot.database.p95DurationMs,
        threshold: 200,
      });
    } else if (snapshot.database.avgDurationMs > 50) {
      bottlenecks.push({
        type: "database",
        severity: "warning",
        description: "Average query time elevated",
        metric: snapshot.database.avgDurationMs,
        threshold: 50,
      });
    }

    // Check storage performance
    if (snapshot.storage.avgUploadLatencyMs > 1000) {
      bottlenecks.push({
        type: "storage",
        severity: "warning",
        description: "Slow storage uploads",
        metric: snapshot.storage.avgUploadLatencyMs,
        threshold: 1000,
      });
    }

    // Check memory usage
    if (snapshot.system.memoryUsagePercent > 90) {
      bottlenecks.push({
        type: "memory",
        severity: "critical",
        description: "High memory usage - possible memory leak",
        metric: snapshot.system.memoryUsagePercent,
        threshold: 90,
      });
    } else if (snapshot.system.memoryUsagePercent > 75) {
      bottlenecks.push({
        type: "memory",
        severity: "warning",
        description: "Elevated memory usage",
        metric: snapshot.system.memoryUsagePercent,
        threshold: 75,
      });
    }

    // Find CPU-intensive database operations
    for (const [operation, stats] of Object.entries(
      snapshot.database.operationBreakdown,
    )) {
      if (stats.cpuIntensive && stats.avgDuration > 100) {
        bottlenecks.push({
          type: "database",
          severity: "warning",
          description: `CPU-intensive operation: ${operation}`,
          metric: stats.avgDuration,
          threshold: 100,
        });
      }
    }

    return bottlenecks;
  }

  /**
   * Generate optimization recommendations
   */
  getRecommendations(): string[] {
    const recommendations: string[] = [];
    const snapshot = this.takeSnapshot();
    const bottlenecks = this.identifyBottlenecks();

    // Cache recommendations
    const cacheHitRate = this.getCacheHitRate();
    if (cacheHitRate < 0.8) {
      recommendations.push(
        `Cache hit rate is ${(cacheHitRate * 100).toFixed(1)}% - consider caching more frequently accessed data`,
      );
    }

    // Database recommendations
    if (snapshot.database.slowQueries > snapshot.database.queries * 0.05) {
      recommendations.push(
        "More than 5% of queries are slow - add database indexes or optimize query patterns",
      );
    }

    // Find slowest operations
    const slowOperations = Object.entries(snapshot.database.operationBreakdown)
      .filter(([, stats]) => stats.avgDuration > 100)
      .sort((a, b) => b[1].avgDuration - a[1].avgDuration)
      .slice(0, 3);

    if (slowOperations.length > 0) {
      recommendations.push(
        "Slowest database operations:\n" +
          slowOperations
            .map(
              ([op, stats]) =>
                `  - ${op}: ${stats.avgDuration.toFixed(2)}ms avg (${stats.count} calls)`,
            )
            .join("\n"),
      );
    }

    // Storage recommendations
    if (snapshot.storage.errors > 0) {
      recommendations.push(
        `${snapshot.storage.errors} storage errors detected - check storage configuration and connectivity`,
      );
    }

    // Memory recommendations
    if (snapshot.system.memoryUsagePercent > 75) {
      recommendations.push(
        `Memory usage at ${snapshot.system.memoryUsagePercent.toFixed(1)}% - consider increasing heap size or investigating memory leaks`,
      );
    }

    // Critical bottlenecks
    const criticalBottlenecks = bottlenecks.filter(
      (b) => b.severity === "critical",
    );
    if (criticalBottlenecks.length > 0) {
      recommendations.push(
        "CRITICAL ISSUES:\n" +
          criticalBottlenecks.map((b) => `  - ${b.description}`).join("\n"),
      );
    }

    return recommendations;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.cacheLatencies = [];
    this.cacheOps = { get: 0, set: 0, delete: 0 };
    this.cacheBytesRead = 0;
    this.cacheBytesWritten = 0;

    this.storageUploads = 0;
    this.storageDownloads = 0;
    this.storageDeletes = 0;
    this.storageBytesUp = 0;
    this.storageBytesDown = 0;
    this.storageUploadLatencies = [];
    this.storageDownloadLatencies = [];
    this.storageErrors = 0;

    this.dbOperations.clear();

    this.requestCount = 0;
    this.activeRequests = 0;

    this.vercelCacheHits = 0;
    this.vercelCacheMisses = 0;

    this.snapshots = [];

    logger.info("Performance metrics reset", undefined, "PerformanceMonitor");
  }

  /**
   * Log performance summary
   */
  logSummary(): void {
    const snapshot = this.takeSnapshot();
    const bottlenecks = this.identifyBottlenecks();
    const recommendations = this.getRecommendations();

    logger.info(
      "Performance Summary",
      {
        cache: {
          hitRate: `${(this.getCacheHitRate() * 100).toFixed(2)}%`,
          avgLatency: `${snapshot.cache.avgLatencyMs.toFixed(2)}ms`,
          totalOps:
            snapshot.cache.operations.get +
            snapshot.cache.operations.set +
            snapshot.cache.operations.delete,
        },
        database: {
          queries: snapshot.database.queries,
          slowQueries: `${snapshot.database.slowQueries} (${snapshot.database.queries > 0 ? ((snapshot.database.slowQueries / snapshot.database.queries) * 100).toFixed(2) : 0}%)`,
          avgDuration: `${snapshot.database.avgDurationMs.toFixed(2)}ms`,
          p95: `${snapshot.database.p95DurationMs.toFixed(2)}ms`,
        },
        storage: {
          uploads: snapshot.storage.uploads,
          downloads: snapshot.storage.downloads,
          errors: snapshot.storage.errors,
        },
        system: {
          memory: `${snapshot.system.memoryUsageMB.toFixed(2)}MB (${snapshot.system.memoryUsagePercent.toFixed(1)}%)`,
          activeRequests: snapshot.system.activeRequests,
          rps: snapshot.system.requestsPerSecond.toFixed(2),
        },
        bottlenecks: bottlenecks.length,
        criticalIssues: bottlenecks.filter((b) => b.severity === "critical")
          .length,
      },
      "PerformanceMonitor",
    );

    if (recommendations.length > 0) {
      logger.info(
        "Performance Recommendations",
        {
          count: recommendations.length,
          recommendations,
        },
        "PerformanceMonitor",
      );
    }
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();

// Auto-snapshot every minute
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    performanceMonitor.takeSnapshot();
  }, 60000);
}
