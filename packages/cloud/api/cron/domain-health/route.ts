/**
 * POST /api/cron/domain-health
 *
 * Periodic cron that probes `https://<domain>/health` for Cloudflare-registered
 * custom domains that are active + verified but not yet confirmed live, flipping
 * `is_live`. Protected by CRON_SECRET. See domain-health service.
 */

import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { domainHealthService } from "@/lib/services/domain-health";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  const startedAt = Date.now();
  try {
    requireCronSecret(c);
    const summary = await domainHealthService.probeDomainHealth();
    if (summary.checked > 0) {
      logger.info("[domain-health-cron] completed", {
        durationMs: Date.now() - startedAt,
        checked: summary.checked,
        live: summary.live,
      });
    }
    return c.json({ success: true, summary });
  } catch (error) {
    logger.error("[domain-health-cron] failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
