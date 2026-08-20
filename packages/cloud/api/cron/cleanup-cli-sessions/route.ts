/**
 * GET|POST /api/cron/cleanup-cli-sessions
 * Cleans up expired CLI auth sessions. Protected by CRON_SECRET.
 *
 * Both verbs are registered: the Worker's scheduled() dispatcher fans out with
 * POST (see `makeCronHandler`), so a GET-only route 404s every cycle.
 */

import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    await cliAuthSessionsService.cleanupExpiredSessions();
    return c.json({
      success: true,
      message: "Expired CLI auth sessions cleaned up successfully",
    });
  } catch (error) {
    logger.error("Error cleaning up CLI auth sessions:", error);
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
