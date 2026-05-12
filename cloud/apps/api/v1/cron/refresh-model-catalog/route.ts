/**
 * /api/v1/cron/refresh-model-catalog
 * Refreshes the gateway model catalog (OpenRouter, Groq, etc.) and persists
 * to cache. Schedule: every 15 minutes (registered in CRON_FANOUT for
 * "*\/15 * * * *"). Protected by CRON_SECRET; supports GET (Workers cron
 * trigger) and POST (manual hits).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { cache } from "@/lib/cache/client";
import { refreshOpenRouterModelCatalog } from "@/lib/services/model-catalog";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function runRefresh(c: AppContext) {
  try {
    requireCronSecret(c);

    const cacheAvailable = cache.isAvailable();
    const models = await refreshOpenRouterModelCatalog();

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
