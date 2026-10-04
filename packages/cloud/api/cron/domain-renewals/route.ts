/**
 * POST /api/cron/domain-renewals
 *
 * Daily cron that re-charges orgs for Cloudflare domains nearing expiry and
 * renews them via the registrar (debit BEFORE registrar action; idempotent per
 * (domain, period)). Protected by CRON_SECRET. See domain-renewals service.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { domainRenewalsService } from "@elizaos/cloud-shared/lib/services/domain-renewals";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  const startedAt = Date.now();
  try {
    requireCronSecret(c);
    const summary = await domainRenewalsService.processDomainRenewals();
    logger.info("[domain-renewals-cron] completed", {
      durationMs: Date.now() - startedAt,
      due: summary.due,
      renewed: summary.renewed,
      alreadyCharged: summary.alreadyCharged,
      declined: summary.declined,
      failed: summary.failed,
    });
    return c.json({ success: true, summary });
  } catch (error) {
    logger.error("[domain-renewals-cron] failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
