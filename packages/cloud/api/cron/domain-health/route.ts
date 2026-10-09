/**
 * POST /api/cron/domain-health
 *
 * Periodic cron that probes `https://<domain>/health` for Cloudflare-registered
 * custom domains that are active + verified but not yet confirmed live, flipping
 * `is_live`. Protected by CRON_SECRET. See domain-health service.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { domainHealthService } from "@elizaos/cloud-shared/lib/services/domain-health";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";

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
