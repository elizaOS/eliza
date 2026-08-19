/** Proxies validated token-trade history requests to the market-data provider. */
import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { executeWithBody } from "@/lib/services/proxy/engine";
import {
  isValidAddress,
  isValidChain,
} from "@/lib/services/proxy/services/address-validation";
import {
  marketDataConfig,
  marketDataHandler,
} from "@/lib/services/proxy/services/market-data";
import { parseClampedLimit, parseClampedOffset } from "@/lib/utils/clamp-limit";
import type { AppEnv } from "@/types/cloud-worker-env";

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
  request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> },
) {
  const { chain, address } = await params;
  const normalizedChain = chain.toLowerCase();
  const { searchParams } = new URL(request.url);

  if (!isValidChain(normalizedChain)) {
    return applyCorsHeaders(
      Response.json(
        {
          error: "Invalid chain",
          details:
            "Supported chains: solana, ethereum, arbitrum, avalanche, bsc, optimism, polygon, base, zksync, sui",
        },
        { status: 400 },
      ),
      CORS_METHODS,
    );
  }

  if (!isValidAddress(normalizedChain, address)) {
    return applyCorsHeaders(
      Response.json(
        {
          error: "Invalid address format",
          details: `Address format invalid for chain: ${normalizedChain}`,
        },
        { status: 400 },
      ),
      CORS_METHODS,
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

  // Token-trade type identity, not leftover tax on market-candles
  // OHLCV type. Unknown tokens (SWAP / buy / 1e2) used to be
  // forwarded to the paid market-data provider.
  const requestedTxType = searchParams.get("tx_type");
  if (
    requestedTxType != null &&
    requestedTxType !== "" &&
    !isTokenTradeType(requestedTxType)
  ) {
    return applyCorsHeaders(
      Response.json(
        {
          error: "Invalid tx_type",
          details: `tx_type must be a canonical Birdeye trade type (${TOKEN_TRADE_TYPES.join(", ")}).`,
        },
        { status: 400 },
      ),
      CORS_METHODS,
    );
  }
  if (requestedTxType) requestParams.tx_type = requestedTxType;

  const body = {
    method: "getTokenTrades",
    chain: normalizedChain,
    params: requestParams,
  };

  return applyCorsHeaders(
    await executeWithBody(marketDataConfig, marketDataHandler, request, body),
    CORS_METHODS,
  );
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async () => __hono_OPTIONS());
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({
      chain: c.req.param("chain")!,
      address: c.req.param("address")!,
    }),
  }),
);
export default __hono_app;
