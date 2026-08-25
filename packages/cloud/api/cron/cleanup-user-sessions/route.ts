/**
 * Runs the bounded telemetry-session lifecycle and retention sweep.
 * Its response and logs contain aggregate counts only, never row identifiers or metadata.
 */

import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { userSessionsService } from "@/lib/services/user-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  const startedAt = Date.now();
  try {
    requireCronSecret(c);
    const metrics = await userSessionsService.cleanupLifecycle();
    logger.info("[UserSessionTelemetry] Lifecycle cleanup completed", {
      ...metrics,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ success: true, ...metrics });
  } catch (error) {
    // error-policy:J1 The authenticated cron route translates one observable failure.
    logger.error("[UserSessionTelemetry] Lifecycle cleanup failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
