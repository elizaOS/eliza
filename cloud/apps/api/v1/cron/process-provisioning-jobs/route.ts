/**
 * /api/v1/cron/process-provisioning-jobs
 * Claims and executes pending provisioning jobs from the `jobs` table using
 * FOR UPDATE SKIP LOCKED to prevent double-processing across overlapping
 * cron invocations. Also recovers stale in_progress jobs.
 *
 * NOTE: provisioningJobService transitively imports node:net (eliza-sandbox)
 * and is currently considered Workers-incompatible. This route stays as a
 * 501 stub until the sandbox provisioning path is split out for the sidecar.
 *
 * Protected by CRON_SECRET. Schedule: every minute (matches deployment-monitor)
 * once it migrates off the sidecar.
 */

import { Hono } from "hono";

const app = new Hono();

app.all("/", (c) =>
  c.json(
    {
      success: false,
      error: "not_yet_migrated",
      reason:
        "depends on @/lib/services/provisioning-jobs which transitively imports node:net via eliza-sandbox; runs on the Node sidecar",
    },
    501,
  ),
);

export default app;
