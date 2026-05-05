/**
 * /api/v1/cron/refresh-pricing
 * Refreshes the AI pricing catalog (per-model token cost lookup). Manual /
 * on-demand only — not currently registered for an automatic schedule in
 * wrangler.toml; can be triggered by an external scheduler or operator.
 * Protected by CRON_SECRET; supports GET (cron) and POST (manual hits).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { refreshPricingCatalog } from "@/lib/services/ai-pricing";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function runRefresh(c: AppContext) {
  try {
    requireCronSecret(c);

    const refresh = await refreshPricingCatalog();

    logger.info("[Pricing Cron] Refreshed pricing catalog", {
      success: refresh.success,
      results: refresh.results,
    });

    return c.json({
      success: refresh.success,
      data: refresh,
    });
  } catch (error) {
    logger.error("[Pricing Cron] Failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
}

app.get("/", runRefresh);
app.post("/", runRefresh);

export default app;
