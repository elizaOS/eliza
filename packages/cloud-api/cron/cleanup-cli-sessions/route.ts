/**
 * GET /api/cron/cleanup-cli-sessions
 * Cleans up expired CLI auth sessions. Protected by CRON_SECRET.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    requireCronSecret(c);
    await cliAuthSessionsService.cleanupExpiredSessions();
    return c.json({ success: true, message: "Expired CLI auth sessions cleaned up successfully" });
  } catch (error) {
    logger.error("Error cleaning up CLI auth sessions:", error);
    return failureResponse(c, error);
  }
});

export default app;
