/**
 * elizaOS Price Sampling Cron Job
 *
 * POST /api/cron/sample-eliza-price
 *
 * Samples elizaOS token price from multiple sources and stores for TWAP calculation.
 * Should be called every 5 minutes by a cron scheduler.
 *
 * SECURITY:
 * - Requires CRON_SECRET header for authentication
 * - Records prices for all networks in parallel
 *
 * RECOMMENDED SCHEDULE: Every 5 minutes
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { twapPriceOracle } from "@/lib/services/twap-price-oracle";
import {
  elizaTokenPriceService,
  ELIZA_TOKEN_ADDRESSES,
  type SupportedNetwork,
} from "@/lib/services/eliza-token-price";
import { logger } from "@/lib/utils/logger";

export const maxDuration = 30;

/**
 * Verify cron secret for authentication using timing-safe comparison.
 * SECURITY: Uses timingSafeEqual to prevent timing attacks on secret.
 */
function verifyCronSecret(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    logger.error("[PriceSample Cron] CRON_SECRET not configured");
    return false;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return false;
  }

  const providedSecret = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  // SECURITY: Timing-safe comparison to prevent timing attacks
  try {
    const secretBuffer = Buffer.from(cronSecret, "utf-8");
    const providedBuffer = Buffer.from(providedSecret, "utf-8");

    if (secretBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(secretBuffer, providedBuffer);
  } catch {
    return false;
  }
}

interface PriceSampleResult {
  network: SupportedNetwork;
  success: boolean;
  price?: number;
  source?: string;
  error?: string;
}

/**
 * POST /api/cron/sample-eliza-price
 * Sample prices from all networks for TWAP calculation.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Verify cron secret
  if (!verifyCronSecret(request)) {
    logger.warn("[PriceSample Cron] Unauthorized access attempt");
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  logger.info("[PriceSample Cron] Starting price sampling");

  const networks: SupportedNetwork[] = ["ethereum", "base", "bnb", "solana"];
  const results: PriceSampleResult[] = [];

  // Sample prices in parallel for all networks
  await Promise.all(
    networks.map(async (network) => {
      try {
        // Get price from the existing price service
        const quote = await elizaTokenPriceService.getPrice(network);

        // Record the sample for TWAP calculation
        await twapPriceOracle.recordPriceSample(
          network,
          quote.priceUsd,
          quote.source,
        );

        results.push({
          network,
          success: true,
          price: quote.priceUsd,
          source: quote.source,
        });

        logger.debug("[PriceSample Cron] Sampled price", {
          network,
          price: quote.priceUsd,
          source: quote.source,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        results.push({
          network,
          success: false,
          error: errorMessage,
        });

        logger.error("[PriceSample Cron] Failed to sample price", {
          network,
          error: errorMessage,
        });
      }
    }),
  );

  // Also run cleanup of old samples
  let cleanedUp = 0;
  try {
    cleanedUp = await twapPriceOracle.cleanupOldSamples();
    logger.debug("[PriceSample Cron] Cleaned up old samples", {
      count: cleanedUp,
    });
  } catch (error) {
    logger.warn("[PriceSample Cron] Failed to cleanup old samples", { error });
  }

  // Get system health for monitoring
  const systemHealth = await twapPriceOracle.getSystemHealth();

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  logger.info("[PriceSample Cron] Completed", {
    successCount,
    failCount,
    cleanedUp,
    systemHealth,
  });

  return NextResponse.json({
    success: true,
    results,
    stats: {
      successCount,
      failCount,
      cleanedUp,
    },
    systemHealth,
  });
}

/**
 * GET - Health check / manual trigger info
 */
export async function GET(): Promise<NextResponse> {
  const systemHealth = await twapPriceOracle.getSystemHealth();

  // Get TWAP status for each network
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

  return NextResponse.json({
    healthy: true,
    cronSecretConfigured: !!process.env.CRON_SECRET,
    twapStatus,
    systemHealth,
  });
}
