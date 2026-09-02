/** Proxies validated token-trade history requests to the market-data provider. */
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
import { parseClampedLimit, parseClampedOffset } from "@/lib/utils/clamp-limit";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, OPTIONS";
export const TOKEN_TRADE_TYPES = Object.freeze([
  "swap",
  "add",
  "remove",
  "all",
] as const);
const TOKEN_TRADE_TYPE_SET = new Set<string>(TOKEN_TRADE_TYPES);

function isTokenTradeType(
  value: string,
): value is (typeof TOKEN_TRADE_TYPES)[number] {
  return TOKEN_TRADE_TYPE_SET.has(value);
}

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
      const rawLimit = searchParams.get("limit");
      if (rawLimit !== null && rawLimit !== "") {
        requestParams.limit = String(parseClampedLimit(rawLimit, 50, 100));
      }
      const rawOffset = searchParams.get("offset");
      if (rawOffset !== null && rawOffset !== "") {
        requestParams.offset = String(parseClampedOffset(rawOffset, 0));
      }
      const requestedTxType = searchParams.get("tx_type");
      if (
        requestedTxType != null &&
        requestedTxType !== "" &&
        !isTokenTradeType(requestedTxType)
      ) {
        return Response.json(
          {
            error: "Invalid tx_type",
            details: `tx_type must be a canonical Birdeye trade type (${TOKEN_TRADE_TYPES.join(", ")}).`,
          },
          { status: 400 },
        );
      }
      if (requestedTxType) requestParams.tx_type = requestedTxType;
      return {
        config: marketDataConfig,
        work: marketDataHandler,
        body: {
          method: "getTokenTrades",
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
