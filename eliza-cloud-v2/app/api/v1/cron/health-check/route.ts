import { NextRequest, NextResponse } from "next/server";
import { monitorAllContainers } from "@/lib/services/health-monitor";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Health check cron handler
 * Serverless-compatible health check endpoint
 *
 * This endpoint should be called by a cron service (e.g., Vercel Cron, GitHub Actions)
 * to monitor container health in serverless environments.
 *
 * Security: Requires CRON_SECRET to prevent unauthorized access
 *
 * Example Vercel Cron configuration (vercel.json):
 * {
 *   "crons": [{
 *     "path": "/api/v1/cron/health-check",
 *     "schedule": "* * * * *"
 *   }]
 * }
 */
async function handleHealthCheck(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      logger.error(
        "[Health Check Cron] CRON_SECRET not configured - rejecting request for security",
      );
      return NextResponse.json(
        {
          success: false,
          error: "Server configuration error: CRON_SECRET not set",
        },
        { status: 500 },
      );
    }

    if (authHeader !== `Bearer ${cronSecret}`) {
      logger.warn("[Health Check Cron] Unauthorized request", {
        ip: request.headers.get("x-forwarded-for"),
        timestamp: new Date().toISOString(),
      });
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized",
        },
        { status: 401 },
      );
    }

    logger.info(
      "[Health Check Cron] Starting scheduled container health check",
    );

    const results = await monitorAllContainers({
      checkIntervalMs: 60000,
      timeout: 10000,
      unhealthyThreshold: 3,
      retryOnFailure: true,
    });

    const healthyCount = results.filter((r) => r.healthy).length;
    const unhealthyCount = results.length - healthyCount;

    logger.info("[Health Check Cron] Health check completed", {
      total: results.length,
      healthy: healthyCount,
      unhealthy: unhealthyCount,
    });

    return NextResponse.json({
      success: true,
      data: {
        total: results.length,
        healthy: healthyCount,
        unhealthy: unhealthyCount,
        timestamp: new Date().toISOString(),
        results: results.map((r) => ({
          containerId: r.containerId,
          healthy: r.healthy,
          statusCode: r.statusCode,
          responseTime: r.responseTime,
          error: r.error,
        })),
      },
    });
  } catch (error) {
    logger.error(
      "[Health Check Cron] Failed:",
      error instanceof Error ? error.message : String(error),
    );

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Health check failed",
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/v1/cron/health-check
 * Cron job endpoint for monitoring container health.
 * Protected by CRON_SECRET. Can be called via GET (Vercel cron) or POST (manual testing).
 *
 * @param request - Request with Bearer token authorization header.
 * @returns Health check results for all containers.
 */
export async function GET(request: NextRequest) {
  return handleHealthCheck(request);
}

/**
 * POST /api/v1/cron/health-check
 * Cron job endpoint for monitoring container health (POST variant).
 * Protected by CRON_SECRET.
 *
 * @param request - Request with Bearer token authorization header.
 * @returns Health check results for all containers.
 */
export async function POST(request: NextRequest) {
  return handleHealthCheck(request);
}
