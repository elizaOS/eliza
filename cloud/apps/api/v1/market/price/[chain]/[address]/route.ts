import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Market Data: Token Price Endpoint
 *
 * GET /api/v1/market/price/{chain}/{address}
 *
 * WHY this route exists:
 * - Most common market data query (90% of use cases)
 * - Real-time price is foundation for portfolio tracking, trading, analytics
 *
 * WHY separate route per method:
 * - RESTful: each resource type has unique URL
 * - Cacheable: CDNs/browsers can cache by URL path
 * - Readable: /market/price/solana/EPj... is self-documenting
 *
 * WHY validate before executeWithBody:
 * - Fail-fast: reject bad input before billing credits
 * - UX: instant error feedback vs slow upstream error
 * - Cost: prevents wasted credits on invalid requests
 */

import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { executeWithBody } from "@/lib/services/proxy/engine";
import { isValidAddress, isValidChain } from "@/lib/services/proxy/services/address-validation";
import { marketDataConfig, marketDataHandler } from "@/lib/services/proxy/services/market-data";

// WHY 30s maxDuration:
// - Upstream calls + retries can take 15-20s
// - 30s provides safety margin without blocking too long
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

  // WHY this body structure:
  // - method: "getPrice" is provider-agnostic (could be Birdeye, CoinGecko, etc.)
  // - chain: passed through to handler for provider-specific routing
  // - params: flexible object allows adding fields without route changes
  const body = {
    method: "getPrice",
    chain: normalizedChain,
    params: { address },
  };

  // WHY executeWithBody not manual billing:
  // - Handles auth, credit reservation, caching, rate limiting automatically
  // - Guarantees credits are refunded on errors
  // - Tracks usage for analytics and billing
  // - Consistent behavior across all service routes
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
