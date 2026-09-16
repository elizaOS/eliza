/** Proxies validated public candle requests to the paid market-data provider. */
import { Hono } from "hono";
import { executeGuardedPaidProxyWithPreflight } from "@/api-app/lib/guarded-paid-proxy";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  isValidAddress,
  isValidChain,
} from "@/lib/services/proxy/services/address-validation";
import {
  marketDataConfig,
  marketDataHandler,
} from "@/lib/services/proxy/services/market-data";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, OPTIONS";
export const OHLCV_TYPES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1H",
  "2H",
  "4H",
  "6H",
  "8H",
  "12H",
  "1D",
  "3D",
  "1W",
  "1M",
] as const;
const OHLCV_TYPE_SET = new Set<string>(OHLCV_TYPES);

async function __hono_OPTIONS() {
  return handleCorsOptions(CORS_METHODS);
}

async function __hono_GET(
  c: AppContext,
  { params }: { params: Promise<{ chain: string; address: string }> },
) {
  return applyCorsHeaders(
    await executeGuardedPaidProxyWithPreflight(c, async () => {
      const { chain, address } = await params;
      const normalizedChain = chain.toLowerCase();
      const { searchParams } = new URL(c.req.raw.url);
      if (!isValidChain(normalizedChain)) {
        return Response.json(
          {
            error: "Invalid chain",
            details:
              "Supported chains: solana, ethereum, arbitrum, avalanche, bsc, optimism, polygon, base, zksync, sui",
          },
          { status: 400 },
        );
      }
      if (!isValidAddress(normalizedChain, address)) {
        return Response.json(
          {
            error: "Invalid address format",
            details: `Address format invalid for chain: ${normalizedChain}`,
          },
          { status: 400 },
        );
      }
      const requestParams: Record<string, string> = { address };
      const requestedType = searchParams.get("type");
      if (
        requestedType != null &&
        requestedType !== "" &&
        !OHLCV_TYPE_SET.has(requestedType)
      ) {
        return Response.json(
          {
            error: "Invalid type",
            details: `type must be a canonical Birdeye OHLCV interval (${OHLCV_TYPES.join(", ")}).`,
          },
          { status: 400 },
        );
      }
      if (requestedType) requestParams.type = requestedType;
      const timeFrom = searchParams.get("time_from");
      if (timeFrom) requestParams.time_from = timeFrom;
      const timeTo = searchParams.get("time_to");
      if (timeTo) requestParams.time_to = timeTo;
      return {
        config: marketDataConfig,
        work: marketDataHandler,
        body: {
          method: "getOHLCV",
          chain: normalizedChain,
          params: requestParams,
        },
      };
    }),
    CORS_METHODS,
  );
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async () => __hono_OPTIONS());
__hono_app.get("/", async (c) =>
  __hono_GET(c, {
    params: Promise.resolve({
      chain: c.req.param("chain")!,
      address: c.req.param("address")!,
    }),
  }),
);
export default __hono_app;
