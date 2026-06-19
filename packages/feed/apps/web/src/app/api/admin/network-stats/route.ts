/**
 * Admin Network Statistics API
 *
 * @route GET /api/admin/network-stats - Get network statistics
 * @access Admin
 *
 * @description
 * Returns real-time network and database statistics including query performance,
 * slow queries, connection metrics, and database health. Admin only.
 *
 * @openapi
 * /api/admin/network-stats:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get network statistics
 *     description: Returns real-time network and database statistics (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queryStats:
 *                   type: object
 *                 slowQueries:
 *                   type: array
 *                 recentQueries:
 *                   type: array
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const stats = await fetch('/api/admin/network-stats', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import { requireAdmin, successResponse, withErrorHandling } from "@feed/api";
import { queryMonitor } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";

/**
 * GET /api/admin/network-stats
 * Get comprehensive network and database statistics
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  // Get query performance stats
  const queryStats = queryMonitor.getQueryStats(60000); // Last minute
  const slowQueries = queryMonitor.getSlowQueryStats();
  const recentQueries = queryMonitor.getRecentQueries(50);

  // Calculate query metrics
  const totalQueries = queryStats.totalQueries;
  const slowQueryRate =
    totalQueries > 0 ? (queryStats.slowQueries / totalQueries) * 100 : 0;

  // Get top 10 slowest query types
  const topSlowQueries = Object.entries(slowQueries)
    .sort((a, b) => b[1].avgDuration - a[1].avgDuration)
    .slice(0, 10)
    .map(([key, stats]) => ({
      query: key,
      count: stats.count,
      avgDuration: Math.round(stats.avgDuration * 100) / 100,
      maxDuration: Math.round(stats.maxDuration * 100) / 100,
    }));

  // Get memory usage
  const memUsage = process.memoryUsage();

  // Get process uptime
  const uptime = process.uptime();

  logger.info(
    "Network stats requested",
    {
      totalQueries,
      slowQueryRate: `${slowQueryRate.toFixed(2)}%`,
    },
    "GET /api/admin/network-stats",
  );

  return successResponse({
    timestamp: new Date().toISOString(),

    // Database query performance
    database: {
      queries: {
        total: totalQueries,
        slow: queryStats.slowQueries,
        slowRate: Math.round(slowQueryRate * 100) / 100,
        avgDuration: Math.round(queryStats.avgDuration * 100) / 100,
        p95Duration: Math.round(queryStats.p95Duration * 100) / 100,
        p99Duration: Math.round(queryStats.p99Duration * 100) / 100,
      },
      topSlowQueries,
      recentQueries: recentQueries.map((q) => ({
        query: q.query,
        duration: Math.round(q.duration * 100) / 100,
        timestamp: q.timestamp,
        model: q.model,
        operation: q.operation,
      })),
    },

    // Server metrics
    server: {
      uptime: {
        seconds: Math.floor(uptime),
        formatted: formatUptime(uptime),
      },
      memory: {
        heapUsed: Math.round((memUsage.heapUsed / 1024 / 1024) * 100) / 100, // MB
        heapTotal: Math.round((memUsage.heapTotal / 1024 / 1024) * 100) / 100, // MB
        external: Math.round((memUsage.external / 1024 / 1024) * 100) / 100, // MB
        rss: Math.round((memUsage.rss / 1024 / 1024) * 100) / 100, // MB
      },
      env: process.env.NODE_ENV,
      pid: process.pid,
    },

    // Health indicators
    health: {
      database:
        slowQueryRate < 5
          ? "healthy"
          : slowQueryRate < 15
            ? "warning"
            : "critical",
      memory:
        memUsage.heapUsed / memUsage.heapTotal < 0.9 ? "healthy" : "warning",
      overall: determineOverallHealth(slowQueryRate, memUsage),
    },
  });
});

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

/**
 * Determine overall system health
 */
function determineOverallHealth(
  slowQueryRate: number,
  memUsage: NodeJS.MemoryUsage,
): "healthy" | "warning" | "critical" {
  const memoryUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

  if (slowQueryRate > 15 || memoryUsagePercent > 95) {
    return "critical";
  }

  if (slowQueryRate > 5 || memoryUsagePercent > 85) {
    return "warning";
  }

  return "healthy";
}
