/**
 * Query Performance Monitoring
 *
 * Tracks database query performance and logs slow queries.
 * Helps identify optimization opportunities under load.
 */

import { logger } from "./logger";

/**
 * Metrics for a single database query execution.
 */
interface QueryMetrics {
  query: string;
  duration: number;
  timestamp: Date;
  model: string;
  operation: string;
}

/**
 * Aggregated statistics for slow queries of a specific type.
 */
interface SlowQueryStats {
  count: number;
  totalDuration: number;
  avgDuration: number;
  maxDuration: number;
  queries: QueryMetrics[];
}

/**
 * Query performance monitor that tracks and aggregates slow query statistics.
 */
class QueryMonitor {
  private slowQueries: Map<string, SlowQueryStats> = new Map();
  private queryLog: QueryMetrics[] = [];
  private readonly SLOW_QUERY_THRESHOLD_MS =
    Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 100;
  private readonly MAX_LOG_SIZE = 1000;
  private readonly STATS_WINDOW_MS = 60000;

  /**
   * Record a database query execution for performance tracking.
   *
   * @param metrics - Query execution metrics
   */
  recordQuery(metrics: QueryMetrics): void {
    this.queryLog.push(metrics);
    if (this.queryLog.length > this.MAX_LOG_SIZE) {
      this.queryLog.shift();
    }

    if (metrics.duration >= this.SLOW_QUERY_THRESHOLD_MS) {
      this.recordSlowQuery(metrics);

      logger.warn("Slow query detected", {
        model: metrics.model,
        operation: metrics.operation,
        duration: `${metrics.duration}ms`,
        threshold: `${this.SLOW_QUERY_THRESHOLD_MS}ms`,
        query: this.sanitizeQuery(metrics.query),
      });
    }
  }

  /**
   * Record a slow query for aggregation
   */
  private recordSlowQuery(metrics: QueryMetrics): void {
    const key = `${metrics.model}:${metrics.operation}`;
    const existing = this.slowQueries.get(key);

    if (existing) {
      existing.count++;
      existing.totalDuration += metrics.duration;
      existing.avgDuration = existing.totalDuration / existing.count;
      existing.maxDuration = Math.max(existing.maxDuration, metrics.duration);
      existing.queries.push(metrics);

      if (existing.queries.length > 10) {
        existing.queries.shift();
      }
    } else {
      this.slowQueries.set(key, {
        count: 1,
        totalDuration: metrics.duration,
        avgDuration: metrics.duration,
        maxDuration: metrics.duration,
        queries: [metrics],
      });
    }
  }

  /**
   * Get aggregated slow query statistics by query type.
   *
   * @returns Object mapping query types to their slow query statistics
   */
  getSlowQueryStats(): Record<string, SlowQueryStats> {
    const stats: Record<string, SlowQueryStats> = {};

    for (const [key, value] of this.slowQueries.entries()) {
      stats[key] = value;
    }

    return stats;
  }

  /**
   * Get recent query metrics from the rolling log.
   *
   * @param limit - Maximum number of queries to return (default: 100)
   * @returns Array of recent query metrics
   */
  getRecentQueries(limit = 100): QueryMetrics[] {
    return this.queryLog.slice(-limit);
  }

  /**
   * Get query statistics for a specified time window.
   *
   * @param windowMs - Time window in milliseconds (default: 60000 = 1 minute)
   * @returns Object containing query statistics including percentiles
   */
  getQueryStats(windowMs: number = this.STATS_WINDOW_MS): {
    totalQueries: number;
    slowQueries: number;
    avgDuration: number;
    p95Duration: number;
    p99Duration: number;
  } {
    const cutoff = Date.now() - windowMs;
    const recentQueries = this.queryLog.filter(
      (q) => q.timestamp.getTime() >= cutoff,
    );

    if (recentQueries.length === 0) {
      return {
        totalQueries: 0,
        slowQueries: 0,
        avgDuration: 0,
        p95Duration: 0,
        p99Duration: 0,
      };
    }

    const durations = recentQueries
      .map((q) => q.duration)
      .sort((a, b) => a - b);
    const slowCount = recentQueries.filter(
      (q) => q.duration >= this.SLOW_QUERY_THRESHOLD_MS,
    ).length;

    const p95Index = Math.floor(durations.length * 0.95);
    const p99Index = Math.floor(durations.length * 0.99);

    return {
      totalQueries: recentQueries.length,
      slowQueries: slowCount,
      avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      p95Duration: durations[p95Index] ?? 0,
      p99Duration: durations[p99Index] ?? 0,
    };
  }

  /**
   * Clean up old query data older than the specified time.
   *
   * @param olderThanMs - Remove data older than this many milliseconds (default: 300000 = 5 minutes)
   */
  cleanup(olderThanMs = 300000): void {
    const cutoff = Date.now() - olderThanMs;

    this.queryLog = this.queryLog.filter(
      (q) => q.timestamp.getTime() >= cutoff,
    );

    for (const [key, stats] of this.slowQueries.entries()) {
      stats.queries = stats.queries.filter(
        (q) => q.timestamp.getTime() >= cutoff,
      );

      if (stats.queries.length === 0) {
        this.slowQueries.delete(key);
      }
    }
  }

  /**
   * Reset all query statistics and clear the query log.
   */
  reset(): void {
    this.slowQueries.clear();
    this.queryLog = [];
  }

  /**
   * Sanitize query string for safe logging by removing sensitive data and truncating.
   *
   * @param query - Query string to sanitize
   * @returns Sanitized query string
   */
  private sanitizeQuery(query: string): string {
    if (query.length > 500) {
      return `${query.substring(0, 500)}...`;
    }

    return query
      .replace(/email\s*=\s*['"][^'"]+['"]/gi, "email=***")
      .replace(/password\s*=\s*['"][^'"]+['"]/gi, "password=***")
      .replace(/phone\s*=\s*['"][^'"]+['"]/gi, "phone=***")
      .replace(/token\s*=\s*['"][^'"]+['"]/gi, "token=***");
  }

  /**
   * Log summary statistics including slow query counts and percentiles.
   */
  logSummary(): void {
    const stats = this.getQueryStats();
    const slowQueryStats = this.getSlowQueryStats();
    const slowQueryCount = Object.keys(slowQueryStats).length;

    logger.info("Query performance summary", {
      totalQueries: stats.totalQueries,
      slowQueries: stats.slowQueries,
      slowQueryPercentage:
        stats.totalQueries > 0
          ? `${((stats.slowQueries / stats.totalQueries) * 100).toFixed(2)}%`
          : "0%",
      avgDuration: `${stats.avgDuration.toFixed(2)}ms`,
      p95Duration: `${stats.p95Duration.toFixed(2)}ms`,
      p99Duration: `${stats.p99Duration.toFixed(2)}ms`,
      uniqueSlowQueries: slowQueryCount,
    });

    if (slowQueryCount > 0) {
      const sortedSlowQueries = Object.entries(slowQueryStats)
        .sort((a, b) => b[1].avgDuration - a[1].avgDuration)
        .slice(0, 5);

      logger.info("Top 5 slowest query types", {
        queries: sortedSlowQueries.map(([key, value]) => ({
          query: key,
          count: value.count,
          avgDuration: `${value.avgDuration.toFixed(2)}ms`,
          maxDuration: `${value.maxDuration.toFixed(2)}ms`,
        })),
      });
    }
  }
}

/**
 * Singleton query monitor instance for tracking database query performance.
 */
export const queryMonitor = new QueryMonitor();

/**
 * Export query monitor types.
 */
export type { QueryMetrics, SlowQueryStats };

if (typeof setInterval !== "undefined") {
  setInterval(() => {
    queryMonitor.cleanup();
  }, 300000);
}

if (
  process.env.NODE_ENV === "development" &&
  typeof setInterval !== "undefined"
) {
  setInterval(() => {
    queryMonitor.logSummary();
  }, 60000);
}
