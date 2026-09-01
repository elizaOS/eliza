// Handles v1 cloud API v1 market token chain address route traffic with route-local auth expectations.
import { Hono } from "hono";
import { executePaidProxyWithCombinedAdmission } from "@/api-app/lib/legacy-proxy-combined-admission";
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

async function __hono_OPTIONS() {
  return handleCorsOptions(CORS_METHODS);
}

async function __hono_GET(
  c: AppContext,
  { params }: { params: Promise<{ chain: string; address: string }> },
) {
  const request = c.req.raw;
  const { chain, address } = await params;
  const normalizedChain = chain.toLowerCase();

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

  const body = {
    method: "getTokenOverview",
    chain: normalizedChain,
    params: { address },
  };

  return applyCorsHeaders(
    await executePaidProxyWithCombinedAdmission(
      c,
      marketDataConfig,
      marketDataHandler,
      request,
      body,
    ),
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
