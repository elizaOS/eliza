/**
 * GET|POST /api/cron/llm-trajectory-purge (scheduled daily via CRON_FANOUT)
 * Deletes recorded model calls (llm_trajectories rows and their payload
 * objects) older than LLM_TRAJECTORY_RETENTION_DAYS. Protected by CRON_SECRET.
 */

import { purgeExpiredLlmTrajectories } from "@elizaos/cloud-shared/lib/services/llm-trajectory-purge";
import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    const result = await purgeExpiredLlmTrajectories();
    return c.json({ success: true, ...result });
  } catch (error) {
    logger.error("[LlmTrajectoryPurgeCron] error purging trajectories:", error);
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
