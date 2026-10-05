/**
 * /api/v1/cron/refresh-model-catalog
 * Refreshes the gateway model catalog (BitRouter, Groq, etc.) and persists
 * to cache. Schedule: every 15 minutes (registered in CRON_FANOUT for
 * "*\/15 * * * *"). Protected by CRON_SECRET; supports GET (Workers cron
 * trigger) and POST (manual hits).
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { cache } from "@elizaos/cloud-shared/lib/cache/client";
import { refreshBitRouterModelCatalog } from "@elizaos/cloud-shared/lib/services/model-catalog";
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

    const cacheAvailable = cache.isAvailable();
    const models = await refreshBitRouterModelCatalog();

    logger.info("[Model Catalog Cron] Refreshed model catalog", {
      modelCount: models.length,
      cacheAvailable,
    });

    return c.json({
      success: true,
      data: {
        modelCount: models.length,
        cacheAvailable,
        persisted: cacheAvailable,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error(
      "[Model Catalog Cron] Failed:",
      error instanceof Error ? error.message : String(error),
    );
    return failureResponse(c, error);
  }
}

app.get("/", runRefresh);
app.post("/", runRefresh);

export default app;
