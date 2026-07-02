/**
 * /api/v1/cron/provisioning-worker-health
 * Cron job that observes the provisioning-worker daemon heartbeat and, when it
 * is stale/absent, alerts ops (structured error log + configured channels).
 * The daemon cannot page about its own death, so this runs separately on the
 * Worker. Schedule: every minute (registered in CRON_FANOUT for "* * * * *"
 * alongside health-check and deployment-monitor).
 * Protected by CRON_SECRET; supports GET (Workers cron trigger) and POST (manual hits).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { monitorProvisioningWorkerHealth } from "@/lib/services/provisioning-worker-health-monitor";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function runProvisioningWorkerHealthCheck(c: AppContext) {
  try {
    requireCronSecret(c);

    const { healthy, stale, health } = await monitorProvisioningWorkerHealth();

    logger.info("[Provisioning Worker Health Cron] Heartbeat check completed", {
      healthy,
      stale,
      required: health.required,
    });

    return c.json({ healthy, stale, health });
  } catch (error) {
    logger.error(
      "[Provisioning Worker Health Cron] Failed:",
      error instanceof Error ? error.message : String(error),
    );
    return failureResponse(c, error);
  }
}

app.get("/", runProvisioningWorkerHealthCheck);
app.post("/", runProvisioningWorkerHealthCheck);

export default app;
