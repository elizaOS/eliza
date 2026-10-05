/**
 * GET /api/v1/market/preview/wallet-overview
 * Public, unauthenticated wallet market overview preview. CORS handled
 * globally; cache + rate-limit policy comes from market-preview service.
 */

import {
  getIpKey,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  loadPublicWalletMarketOverview,
  PUBLIC_MARKET_OVERVIEW_CACHE_CONTROL,
  PUBLIC_MARKET_PREVIEW_CORS_METHODS,
  PUBLIC_WALLET_OVERVIEW_RATE_LIMIT,
} from "@elizaos/cloud-shared/lib/services/market-preview";
import {
  applyCorsHeaders,
  handleCorsOptions,
} from "@elizaos/cloud-shared/lib/services/proxy/cors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.options("/", () => handleCorsOptions(PUBLIC_MARKET_PREVIEW_CORS_METHODS));

app.use(
  "*",
  rateLimit({
    windowMs: PUBLIC_WALLET_OVERVIEW_RATE_LIMIT.windowMs,
    maxRequests: PUBLIC_WALLET_OVERVIEW_RATE_LIMIT.maxRequests,
    keyGenerator: (c) => `wallet-overview:${getIpKey(c)}`,
  }),
);

app.get("/", async (c) => {
  try {
    const data = await loadPublicWalletMarketOverview();
    const response = c.json(data);
    response.headers.set("Cache-Control", PUBLIC_MARKET_OVERVIEW_CACHE_CONTROL);
    return applyCorsHeaders(response, PUBLIC_MARKET_PREVIEW_CORS_METHODS);
  } catch (error) {
    logger.error("[market-preview/wallet-overview] Failed to load", {
      error: error instanceof Error ? error.message : String(error),
    });
    return applyCorsHeaders(
      c.json({ error: "Failed to load wallet market preview" }, 502),
      PUBLIC_MARKET_PREVIEW_CORS_METHODS,
    );
  }
});

export default app;
