// Handles v1 cloud API v1 market portfolio chain address route traffic with route-local auth expectations.
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
      return {
        config: marketDataConfig,
        work: marketDataHandler,
        body: {
          method: "getWalletPortfolio",
          chain: normalizedChain,
          params: { wallet: address },
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
