/**
 * GET /api/v1/market/preview/wallet-overview
 * Public, unauthenticated wallet market overview preview. CORS handled
 * globally; cache + rate-limit policy comes from market-preview service.
 */

import { Hono } from "hono";
import { fetchHonoRoot } from "@/lib/api/hono-root-request";
import { getIpKey, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  loadPublicWalletMarketOverview,
  PUBLIC_MARKET_OVERVIEW_CACHE_CONTROL,
  PUBLIC_MARKET_PREVIEW_CORS_METHODS,
  PUBLIC_WALLET_OVERVIEW_RATE_LIMIT,
} from "@/lib/services/market-preview";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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

export const GET = (request: Request) => fetchHonoRoot(app, request);
