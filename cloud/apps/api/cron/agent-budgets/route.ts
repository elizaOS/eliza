/**
 * /api/cron/agent-budgets — process agent budget maintenance tasks
 * (auto-refills, daily resets, low budget alerts). Protected by CRON_SECRET.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { agentBudgetService } from "@/lib/services/agent-budgets";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const startTime = Date.now();
  try {
    requireCronSecret(c);
    logger.info("[AgentBudgets Cron] Starting budget maintenance");

    const refillResults = await agentBudgetService.processAutoRefills();
    const duration = Date.now() - startTime;

    logger.info("[AgentBudgets Cron] Completed", {
      duration,
      refillsProcessed: refillResults.processed,
      refillErrors: refillResults.errors,
    });

    return c.json({
      success: true,
      duration,
      results: { autoRefills: refillResults },
    });
  } catch (error) {
    logger.error("[AgentBudgets Cron] Failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    requireCronSecret(c);
    return c.json({
      status: "ready",
      description: "Agent budget maintenance cron job",
      tasks: ["Auto-refill low budgets", "Reset daily spending limits", "Send low budget alerts"],
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
