/**
 * Admin Performance Monitoring API
 *
 * @route GET /api/admin/performance - Get performance metrics
 * @access Admin
 *
 * @description
 * Returns real-time performance metrics including bottlenecks, recommendations,
 * slow queries, and system health. Used for monitoring and optimization.
 *
 * @openapi
 * /api/admin/performance:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get performance metrics
 *     description: Returns real-time performance metrics (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Metrics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stats:
 *                   type: object
 *                 bottlenecks:
 *                   type: array
 *                 recommendations:
 *                   type: array
 *                 slowQueries:
 *                   type: array
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const metrics = await fetch('/api/admin/performance', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import {
  performanceMonitor,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { queryMonitor } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";

/**
 * GET /api/admin/performance
 * Get comprehensive real-time performance metrics
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  // Get performance snapshot
  const perfSnapshot = performanceMonitor.getStats();

  // Get bottlenecks
  const bottlenecks = performanceMonitor.identifyBottlenecks();

  // Get recommendations
  const recommendations = performanceMonitor.getRecommendations();

  // Get slow queries
  const slowQueries = queryMonitor.getSlowQueryStats();

  // Get top slow queries
  const topSlowQueries = Object.entries(slowQueries)
    .sort((a, b) => b[1].avgDuration - a[1].avgDuration)
    .slice(0, 10)
    .map(([query, stats]) => ({
      query,
      count: stats.count,
      avgDuration: Math.round(stats.avgDuration * 100) / 100,
      maxDuration: Math.round(stats.maxDuration * 100) / 100,
    }));

  logger.info(
    "Performance metrics requested",
    {
      bottlenecks: bottlenecks.length,
      criticalIssues: bottlenecks.filter((b) => b.severity === "critical")
        .length,
    },
    "GET /api/admin/performance",
  );

  return successResponse({
    timestamp: new Date().toISOString(),
    cache: {
      hitRate: performanceMonitor.getCacheHitRate(),
      hits: perfSnapshot.cache.hits,
      misses: perfSnapshot.cache.misses,
      avgLatencyMs: perfSnapshot.cache.avgLatencyMs,
      operations: perfSnapshot.cache.operations,
      bytesRead: perfSnapshot.cache.bytesRead,
      bytesWritten: perfSnapshot.cache.bytesWritten,
    },
    database: {
      totalQueries: perfSnapshot.database.queries,
      slowQueries: perfSnapshot.database.slowQueries,
      slowQueryRate:
        perfSnapshot.database.queries > 0
          ? perfSnapshot.database.slowQueries / perfSnapshot.database.queries
          : 0,
      avgDurationMs: perfSnapshot.database.avgDurationMs,
      p95DurationMs: perfSnapshot.database.p95DurationMs,
      p99DurationMs: perfSnapshot.database.p99DurationMs,
      topSlowQueries,
      operationCount: Object.keys(perfSnapshot.database.operationBreakdown)
        .length,
    },
    storage: {
      uploads: perfSnapshot.storage.uploads,
      downloads: perfSnapshot.storage.downloads,
      deletes: perfSnapshot.storage.deletes,
      errors: perfSnapshot.storage.errors,
      errorRate:
        perfSnapshot.storage.uploads +
          perfSnapshot.storage.downloads +
          perfSnapshot.storage.deletes >
        0
          ? perfSnapshot.storage.errors /
            (perfSnapshot.storage.uploads +
              perfSnapshot.storage.downloads +
              perfSnapshot.storage.deletes)
          : 0,
      avgUploadLatencyMs: perfSnapshot.storage.avgUploadLatencyMs,
      avgDownloadLatencyMs: perfSnapshot.storage.avgDownloadLatencyMs,
      bytesUploaded: perfSnapshot.storage.bytesUploaded,
      bytesDownloaded: perfSnapshot.storage.bytesDownloaded,
    },
    system: {
      cpuUsagePercent: perfSnapshot.system.cpuUsagePercent,
      memoryUsageMB: perfSnapshot.system.memoryUsageMB,
      memoryUsagePercent: perfSnapshot.system.memoryUsagePercent,
      uptimeSeconds: perfSnapshot.system.uptimeSeconds,
      activeRequests: perfSnapshot.system.activeRequests,
      requestsPerSecond: perfSnapshot.system.requestsPerSecond,
    },
    vercelCache: perfSnapshot.vercelCache || null,
    bottlenecks: bottlenecks.map((b) => ({
      type: b.type,
      severity: b.severity,
      description: b.description,
      metric: b.metric,
      threshold: b.threshold,
    })),
    recommendations,
    summary: {
      criticalIssues: bottlenecks.filter((b) => b.severity === "critical")
        .length,
      warnings: bottlenecks.filter((b) => b.severity === "warning").length,
      totalRecommendations: recommendations.length,
    },
  });
});
