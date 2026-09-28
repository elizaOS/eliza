/**
 * POST /api/cron/agent-funding-retention (hourly, CRON_SECRET).
 *
 * Advances the funding-stop retention clock (#22967): discovers agents whose
 * funding stopped, sends the 7-day and 1-day deletion notices, removes the
 * container through the sleep lifecycle after 30 days and pins the latest
 * backup for 90 more days. Paying first resumes the same agent through the
 * existing resume paths, which closes the clock.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { agentFundingRetentionService } from "@/lib/services/agent-funding-retention";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const summary = await agentFundingRetentionService.reconcile();
    if (summary.failures.length > 0 || summary.blocked.length > 0) {
      logger.error("[Agent Funding Retention] Run finished with failures", {
        failures: summary.failures,
        blocked: summary.blocked,
      });
    }
    return c.json({ success: summary.failures.length === 0, ...summary });
  } catch (error) {
    logger.error("[Agent Funding Retention] Run failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
