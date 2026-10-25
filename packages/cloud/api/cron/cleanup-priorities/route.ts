/**
 * GET /api/cron/cleanup-priorities
 * Cleanup expired ALB priorities (free up slots from deleted containers).
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { dbPriorityManager } from "@elizaos/cloud-shared/lib/services/alb-priority-manager";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    requireCronSecret(c);

    const statsBefore = await dbPriorityManager.getStats();
    const deletedCount = await dbPriorityManager.cleanupExpiredPriorities();
    const statsAfter = await dbPriorityManager.getStats();

    return c.json({
      success: true,
      data: {
        deleted_count: deletedCount,
        stats_before: statsBefore,
        stats_after: statsAfter,
      },
    });
  } catch (error) {
    logger.error("Cron job error:", error);
    return failureResponse(c, error);
  }
});

export default app;
