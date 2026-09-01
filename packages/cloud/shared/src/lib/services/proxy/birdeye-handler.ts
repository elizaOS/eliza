/**
 * Shared Birdeye upstream proxy handler for `/api/v1/apis/birdeye/*`.
 * `/api/v1/proxy/birdeye/*` issues a 308 to this path.
 */

import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";
import { failureResponse } from "../../api/cloud-worker-errors";
import { logger } from "../../utils/logger";
import { executeWithBody, type ProxyCombinedAdmission } from "./engine";
import { getServiceMethodCost } from "./pricing";
import type { ServiceConfig, ServiceHandler } from "./types";

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

const combinedBirdeyeConfig: ServiceConfig = {
  id: "market-data",
  name: "Birdeye market data proxy",
  auth: "apiKeyWithOrg",
  getCost: async (body) => {
    if (!body || Array.isArray(body) || typeof body !== "object") {
      throw new Error("Invalid Birdeye proxy request");
    }
    const method = "method" in body ? String(body.method) : "";
    return getServiceMethodCost("market-data", method);
  },
};

function createCombinedBirdeyeHandler(
  c: Context<AppEnv>,
  pathStr: string,
  birdeyeApiKey: string,
): ServiceHandler {
  return async () => {
    const upstreamUrl = new URL(`${BIRDEYE_BASE}/${pathStr}`);
    const requestUrl = new URL(c.req.url);
    requestUrl.searchParams.forEach((value, key) => {
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
        ...(upstreamResponse.status >= 500 ? { actualCost: 0 } : {}),
      };
    } catch (error) {
      // error-policy:J1 the paid proxy boundary returns an explicit upstream
      // failure while the engine asynchronously reconciles the admission to 0.
      const isAbort = error instanceof Error && error.name === "AbortError";
      logger.warn("[BirdeyeProxy] upstream dispatch failed", {
        path: pathStr,
        kind: isAbort ? "timeout" : "transport",
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        response: Response.json(
          {
            error: isAbort ? "Upstream service timeout" : "Upstream service unavailable",
          },
          { status: isAbort ? 504 : 502 },
        ),
        actualCost: 0,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

export async function handleBirdeyeMarketDataProxyGet(
  c: Context<AppEnv>,
  combinedAdmission: ProxyCombinedAdmission,
): Promise<Response> {
  try {
    const routePath = c.req.param("*");
    const pathStr = (
      routePath && routePath.length > 0
        ? routePath
        : new URL(c.req.url).pathname.replace(/^\/api\/v1\/apis\/birdeye\/?/, "")
    ).replace(/^\/+|\/+$/g, "");
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

    return executeWithBody(
      combinedBirdeyeConfig,
      createCombinedBirdeyeHandler(c, pathStr, birdeyeApiKey),
      c.req.raw,
      { method: pricedMethod, path: pathStr },
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
