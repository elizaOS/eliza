/**
 * Shared Birdeye upstream proxy handler for `/api/v1/apis/birdeye/*`.
 * `/api/v1/proxy/birdeye/*` issues a 308 to this path.
 */

import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";
import { failureResponse } from "../../api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "../../auth/workers-hono-auth";
import { logger } from "../../utils/logger";
import { creditsService } from "../credits";
import { getServiceMethodCost } from "./pricing";

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
    const deductResult = await creditsService.deductCredits({
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
    });

    if (!deductResult.success) {
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

    // Mirror the engine's billing policy (resolveBillableCost refunds on >=500):
    // we already debited `cost` upfront, so refund it when the upstream FAILS
    // server-side (Birdeye 5xx outage) — the customer got no usable response. We
    // keep the charge on 4xx (the customer's own bad request still consumed our
    // Birdeye quota). Engine-backed market-data routes already refund; this
    // direct handler must match.
    if (upstreamResponse.status >= 500) {
      await creditsService
        .refundCredits({
          organizationId: organization_id,
          amount: cost,
          description: `API proxy refund: market-data — ${pricedMethod} (upstream ${upstreamResponse.status})`,
          metadata: {
            type: "proxy_market-data_refund",
            service: "market-data",
            provider: "birdeye",
            method: pricedMethod,
          },
        })
        .catch((refundError) => {
          logger.warn("[BirdeyeProxy] refund after upstream failure failed", {
            method: pricedMethod,
            status: upstreamResponse.status,
            error: refundError instanceof Error ? refundError.message : String(refundError),
          });
        });
    }

    return new Response(body, {
      status: upstreamResponse.status,
      headers: {
        "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (error) {
    // error-policy:J1 route boundary — translate any handler throw (auth
    // rejection, pricing lookup, upstream fetch) into a structured failure
    // response for the client. No success is fabricated: failureResponse emits
    // { success: false, error, code } with an inferred 4xx/5xx status.
    return failureResponse(c, error);
  }
}
