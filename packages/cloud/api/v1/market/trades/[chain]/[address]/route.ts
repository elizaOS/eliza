// Handles v1 cloud API v1 market trades chain address route traffic with route-local auth expectations.
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
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, OPTIONS";

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

  const limit = searchParams.get("limit");
  if (limit) requestParams.limit = limit;

  const offset = searchParams.get("offset");
  if (offset) requestParams.offset = offset;

  // Token-trade type identity, not leftover tax on market-candles
  // OHLCV type. Unknown tokens (SWAP / buy / 1e2) used to be
  // forwarded to the paid market-data provider.
  const TX_TYPES = ["swap", "add", "remove", "all"] as const;
  const requestedTxType = searchParams.get("tx_type");
  if (
    requestedTxType != null &&
    requestedTxType !== "" &&
    !TX_TYPES.includes(requestedTxType as (typeof TX_TYPES)[number])
  ) {
    return applyCorsHeaders(
      Response.json(
        {
          error: "Invalid tx_type",
          details:
            "tx_type must be a canonical Birdeye trade type (swap, add, remove, all).",
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
