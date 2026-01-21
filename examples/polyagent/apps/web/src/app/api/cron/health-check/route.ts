/**
 * Health Check Cron Job API
 *
 * @route GET /api/cron/health-check - System health check
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Simple health check endpoint that runs every 15 minutes to keep serverless
 * functions warm, verify database connectivity, and log system health metrics.
 * Max execution time: 60s.
 *
 * @openapi
 * /api/cron/health-check:
 *   get:
 *     tags:
 *       - Cron
 *     summary: System health check
 *     description: Verifies database connectivity and system health (requires CRON_SECRET)
 *     security:
 *       - CronSecret: []
 *     responses:
 *       200:
 *         description: System healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 status:
 *                   type: string
 *                   enum: [healthy, unhealthy]
 *                 database:
 *                   type: string
 *                   enum: [connected, error]
 *                 duration:
 *                   type: number
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Invalid or missing CRON_SECRET
 *       500:
 *         description: System unhealthy
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/cron/health-check', {
 *   headers: { 'Authorization': `Bearer ${CRON_SECRET}` }
 * });
 * const { status, database } = await response.json();
 * ```
 */

import { verifyCronAuth } from "@polyagent/api";
import { db } from "@polyagent/db";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Vercel function configuration
export const maxDuration = 60; // 1 minute max for health check
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startTime = Date.now();

  // Verify cron authorization using centralized auth
  if (!verifyCronAuth(request, { jobName: "HealthCheck" })) {
    logger.warn("Unauthorized health check attempt", undefined, "HealthCheck");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Quick database health check
  await db.$queryRaw`SELECT 1`;

  const duration = Date.now() - startTime;

  logger.info(
    "Health check passed",
    {
      duration,
      timestamp: new Date().toISOString(),
    },
    "HealthCheck",
  );

  return NextResponse.json({
    success: true,
    status: "healthy",
    database: "connected",
    duration,
    timestamp: new Date().toISOString(),
  });
}
