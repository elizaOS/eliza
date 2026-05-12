/**
 * /api/cron/sample-eliza-price
 * Every 5min — samples elizaOS token price across networks for TWAP.
 * POST is protected by CRON_SECRET; GET is an unauth health/status endpoint.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { elizaTokenPriceService, type SupportedNetwork } from "@/lib/services/eliza-token-price";
import { twapPriceOracle } from "@/lib/services/twap-price-oracle";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface PriceSampleResult {
  network: SupportedNetwork;
  success: boolean;
  price?: number;
  source?: string;
  error?: string;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);

    logger.info("[PriceSample Cron] Starting price sampling");

    const networks: SupportedNetwork[] = ["ethereum", "base", "bnb", "solana"];
    const results: PriceSampleResult[] = [];

    await Promise.all(
      networks.map(async (network) => {
        try {
          const quote = await elizaTokenPriceService.getPrice(network);
          await twapPriceOracle.recordPriceSample(network, quote.priceUsd, quote.source);
          results.push({
            network,
            success: true,
            price: quote.priceUsd,
            source: quote.source,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          results.push({ network, success: false, error: errorMessage });
          logger.error("[PriceSample Cron] Failed to sample price", {
            network,
            error: errorMessage,
          });
        }
      }),
    );

    let cleanedUp = 0;
    try {
      cleanedUp = await twapPriceOracle.cleanupOldSamples();
    } catch (error) {
      logger.warn("[PriceSample Cron] Failed to cleanup old samples", { error });
    }

    const systemHealth = await twapPriceOracle.getSystemHealth();
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    logger.info("[PriceSample Cron] Completed", {
      successCount,
      failCount,
      cleanedUp,
      systemHealth,
    });

    return c.json({
      success: true,
      results,
      stats: { successCount, failCount, cleanedUp },
      systemHealth,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  const systemHealth = await twapPriceOracle.getSystemHealth();
  const networks: SupportedNetwork[] = ["ethereum", "base", "bnb", "solana"];
  const twapStatus: Record<
    string,
    {
      hasTwap: boolean;
      sampleCount?: number;
      twapPrice?: number;
      volatility?: number;
      isStable?: boolean;
    }
  > = {};

  for (const network of networks) {
    const twap = await twapPriceOracle.getTWAP(network);
    twapStatus[network] = {
      hasTwap: !!twap,
      sampleCount: twap?.sampleCount,
      twapPrice: twap?.twapPrice,
      volatility: twap?.volatility,
      isStable: twap?.isStable,
    };
  }

  return c.json({
    healthy: true,
    cronSecretConfigured: !!c.env.CRON_SECRET,
    twapStatus,
    systemHealth,
  });
});

export default app;
