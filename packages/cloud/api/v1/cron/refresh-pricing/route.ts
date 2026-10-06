/**
 * /api/v1/cron/refresh-pricing
 * Refreshes the AI pricing catalog (per-model token cost lookup). Manual /
 * on-demand only — not currently registered for an automatic schedule in
 * wrangler.toml; can be triggered by an external scheduler or operator.
 * Protected by CRON_SECRET; supports GET (cron) and POST (manual hits).
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { refreshPricingCatalog } from "@elizaos/cloud-shared/lib/services/ai-pricing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
