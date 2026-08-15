/** Fires due Shared reminders through the canonical scheduler and trusted gateway. */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { processDueSharedReminders } from "@/lib/services/shared-runtime/shared-reminder-cron";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const stats = await processDueSharedReminders(c.env);
    logger.info("[SharedReminders] scheduled task sweep complete", stats);
    return c.json({ success: true, stats });
  } catch (error) {
    // error-policy:J1 cron boundary translates one observable failure response.
    logger.error("[SharedReminders] scheduled task sweep failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
