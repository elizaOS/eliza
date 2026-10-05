/**
 * GET|POST /api/cron/llm-trajectory-purge (scheduled daily via CRON_FANOUT)
 * Deletes recorded model calls (llm_trajectories rows and their payload
 * objects) older than LLM_TRAJECTORY_RETENTION_DAYS. Protected by CRON_SECRET.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { purgeExpiredLlmTrajectories } from "@elizaos/cloud-shared/lib/services/llm-trajectory-purge";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";

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
