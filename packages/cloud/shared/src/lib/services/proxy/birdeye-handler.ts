/**
 * Shared Birdeye upstream proxy handler for `/api/v1/apis/birdeye/*`.
 * `/api/v1/proxy/birdeye/*` issues a 308 to this path.
 */

import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";
import { failureResponse } from "../../api/cloud-worker-errors";
import { logger } from "../../utils/logger";
import { executeWithBody, type ProxyCombinedAdmission } from "./engine";
import { marketDataConfig } from "./services/market-data";

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

export async function handleBirdeyeMarketDataProxyGet(
  c: Context<AppEnv>,
  resolveCombinedAdmission: () => Promise<ProxyCombinedAdmission>,
): Promise<Response> {
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

    const birdeyeApiKey = c.env.BIRDEYE_API_KEY as string | undefined;
    if (!birdeyeApiKey) {
      logger.error("BIRDEYE_API_KEY not configured on cloud server");
      return c.json({ error: "Birdeye proxy not available — server misconfigured" }, 503);
    }

    const combinedAdmission = await resolveCombinedAdmission();
    return await executeWithBody(
      marketDataConfig,
      async () => {
        const upstreamUrl = new URL(`${BIRDEYE_BASE}/${pathStr}`);
        const url = new URL(c.req.url);
        url.searchParams.forEach((value, key) => {
          upstreamUrl.searchParams.set(key, value);
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          const upstreamResponse = await fetch(upstreamUrl.toString(), {
            headers: {
              Accept: "application/json",
              "x-chain": c.req.header("x-chain") ?? "solana",
              "X-API-KEY": birdeyeApiKey,
            },
            signal: controller.signal,
          });
          const body = await upstreamResponse.text();
          return {
            response: new Response(body, {
              status: upstreamResponse.status,
              headers: {
                "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "application/json",
              },
            }),
          };
        } catch (error) {
          // error-policy:J1 upstream boundary — transport and deadline failures
          // become explicit 502/504 responses after admission has already run.
          const isAbort = error instanceof Error && error.name === "AbortError";
          if (isAbort) {
            const timeout = new Error("Upstream service timeout");
            timeout.name = "TimeoutError";
            throw timeout;
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      c.req.raw,
      {
        method: pricedMethod,
        chain: (c.req.header("x-chain") ?? "solana").toLowerCase(),
        params: {},
      },
      combinedAdmission,
    );
  } catch (error) {
    // error-policy:J1 route boundary — translate any handler throw (auth
    // rejection, pricing lookup, upstream fetch) into a structured failure
    // response for the client. No success is fabricated: failureResponse emits
    // { success: false, error, code } with an inferred 4xx/5xx status.
    return failureResponse(c, error);
  }
}
