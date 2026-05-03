/**
 * GET /api/cron/cleanup-priorities
 * Cleanup expired ALB priorities (free up slots from deleted containers).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { dbPriorityManager } from "@/lib/services/alb-priority-manager";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    requireCronSecret(c);

    const statsBefore = await dbPriorityManager.getStats();
    const deletedCount = await dbPriorityManager.cleanupExpiredPriorities();
    const statsAfter = await dbPriorityManager.getStats();

    return c.json({
      success: true,
      data: { deleted_count: deletedCount, stats_before: statsBefore, stats_after: statsAfter },
    });
  } catch (error) {
    logger.error("Cron job error:", error);
    return failureResponse(c, error);
  }
});

export default app;
