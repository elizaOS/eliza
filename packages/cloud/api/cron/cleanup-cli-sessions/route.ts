/**
 * GET|POST /api/cron/cleanup-cli-sessions
 * Cleans up expired CLI auth sessions. Protected by CRON_SECRET.
 *
 * Both verbs are registered: the Worker's scheduled() dispatcher fans out with
 * POST (see `makeCronHandler`), so a GET-only route 404s every cycle.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { cliAuthSessionsService } from "@elizaos/cloud-shared/lib/services/cli-auth-sessions";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    const { deletedSessions, revokedOrphanKeys } =
      await cliAuthSessionsService.cleanupExpiredSessions();
    return c.json({
      success: true,
      message: `Reaped ${deletedSessions} expired CLI auth sessions; revoked ${revokedOrphanKeys} orphan keys`,
      deletedSessions,
      revokedOrphanKeys,
    });
  } catch (error) {
    logger.error("Error cleaning up CLI auth sessions:", error);
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
