/**
 * Shared Birdeye upstream proxy handler for `/api/v1/apis/birdeye/*`.
 * `/api/v1/proxy/birdeye/*` issues a 308 to this path.
 */

import type { Context } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const BIRDEYE_BASE = "https://public-api.birdeye.so";

/** Map first path segment(s) (no leading slash) to a priced `market-data` method. */
export const BIRDEYE_PRICED_PATHS: Record<string, string> = {
  "defi/price": "getPrice",
  "defi/history_price": "getPriceHistorical",
  "defi/ohlcv": "getOHLCV",
  "defi/token_overview": "getTokenOverview",
  "defi/token_security": "getTokenSecurity",
  "defi/v3/token/meta-data/single": "getTokenMetadata",
  "defi/txs/token": "getTokenTrades",
  "defi/token_trending": "getTrending",
  "v1/wallet/token_list": "getWalletPortfolio",
  "defi/v3/search": "search",
  "defi/v3/token/market-data": "getTokenMarketDataV3",
  "defi/price_volume/single": "getPriceVolumeSingle",
  "defi/v3/token/trade-data/single": "getTokenTradeDataSingle",
  "defi/multi_price": "getMultiPrice",
  "v1/wallet/tx_list": "getWalletTxList",
};

export async function handleBirdeyeMarketDataProxyGet(c: Context<AppEnv>): Promise<Response> {
  try {
    const pathStr = (c.req.param("*") ?? "").replace(/^\/+|\/+$/g, "");
    const pricedMethod = BIRDEYE_PRICED_PATHS[pathStr];
    if (!pricedMethod) {
      return c.json(
        {
          error: "Unpriced Birdeye proxy path is disabled",
          supportedPaths: Object.keys(BIRDEYE_PRICED_PATHS),
        },
        400,
      );
    }

    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const birdeyeApiKey = c.env.BIRDEYE_API_KEY as string | undefined;
    if (!birdeyeApiKey) {
      logger.error("BIRDEYE_API_KEY not configured on cloud server");
      return c.json({ error: "Birdeye proxy not available — server misconfigured" }, 503);
    }

    const cost = await getServiceMethodCost("market-data", pricedMethod);
    const deductResult = await creditsService
      .deductCredits({
        organizationId: organization_id,
        amount: cost,
        description: `API proxy: market-data — ${pricedMethod}`,
        metadata: {
          type: "proxy_market-data",
          service: "market-data",
          provider: "birdeye",
          method: pricedMethod,
          path: pathStr,
        },
      })
      .catch(() => null);

    if (deductResult === null || !deductResult.success) {
      return c.json(
        {
          error: "Insufficient credits",
          topUpUrl: "https://www.elizacloud.ai/dashboard/billing",
        },
        402,
      );
    }

    const upstreamUrl = new URL(`${BIRDEYE_BASE}/${pathStr}`);
    const url = new URL(c.req.url);
    url.searchParams.forEach((value, key) => {
      upstreamUrl.searchParams.set(key, value);
    });

    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      headers: {
        Accept: "application/json",
        "x-chain": c.req.header("x-chain") ?? "solana",
        "X-API-KEY": birdeyeApiKey,
      },
    });

    const body = await upstreamResponse.text();

    return new Response(body, {
      status: upstreamResponse.status,
      headers: {
        "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
}
