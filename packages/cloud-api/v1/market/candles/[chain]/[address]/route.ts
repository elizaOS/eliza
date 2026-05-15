import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { executeWithBody } from "@/lib/services/proxy/engine";
import { isValidAddress, isValidChain } from "@/lib/services/proxy/services/address-validation";
import { marketDataConfig, marketDataHandler } from "@/lib/services/proxy/services/market-data";
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

  const type = searchParams.get("type");
  if (type) requestParams.type = type;

  const timeFrom = searchParams.get("time_from");
  if (timeFrom) requestParams.time_from = timeFrom;

  const timeTo = searchParams.get("time_to");
  if (timeTo) requestParams.time_to = timeTo;

  const body = {
    method: "getOHLCV",
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
    params: Promise.resolve({ chain: c.req.param("chain")!, address: c.req.param("address")! }),
  }),
);
export default __hono_app;
