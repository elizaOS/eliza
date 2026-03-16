/**
 * Agent Budget Cron Job
 *
 * Scheduled job to process:
 * - Auto-refills for low budgets
 * - Daily spending reset
 * - Low budget alerts
 *
 * Should be called every 15 minutes via Vercel Cron or external scheduler.
 * Protected by CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { agentBudgetService } from "@/lib/services/agent-budgets";
import { logger } from "@/lib/utils/logger";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST /api/cron/agent-budgets
 * Process agent budget maintenance tasks
 */
export async function POST(request: NextRequest): Promise<Response> {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    logger.info("[AgentBudgets Cron] Starting budget maintenance");

    // Process auto-refills
    const refillResults = await agentBudgetService.processAutoRefills();

    const duration = Date.now() - startTime;

    logger.info("[AgentBudgets Cron] Completed", {
      duration,
      refillsProcessed: refillResults.processed,
      refillErrors: refillResults.errors,
    });

    return NextResponse.json({
      success: true,
      duration,
      results: {
        autoRefills: refillResults,
      },
    });
  } catch (error) {
    logger.error("[AgentBudgets Cron] Failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/cron/agent-budgets
 * Health check and status
 */
export async function GET(request: NextRequest): Promise<Response> {
  // Verify cron secret for status check
  const authHeader = request.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    status: "ready",
    description: "Agent budget maintenance cron job",
    tasks: [
      "Auto-refill low budgets",
      "Reset daily spending limits",
      "Send low budget alerts",
    ],
  });
}
