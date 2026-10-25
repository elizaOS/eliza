// Handles v1 cloud API v1 solana transactions address route traffic with route-local auth expectations.

import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

/**
 * Solana Transactions API - Get transactions by address
 *
 * Public API for retrieving transaction history for a Solana address.
 *
 * CORS: Unrestricted by design - see lib/services/proxy/cors.ts for security rationale.
 * Authentication: API key required (X-API-Key header)
 * Rate Limiting: Per API key
 */

import {
  getCorsHeaders,
  handleCorsOptions,
} from "@elizaos/cloud-shared/lib/services/proxy/cors";
import {
  solanaRpcConfig,
  solanaRpcHandler,
} from "@elizaos/cloud-shared/lib/services/proxy/solana-rpc";
import { isValidSolanaAddress } from "@elizaos/cloud-shared/lib/services/proxy/solana-validation";
import { executeGuardedPaidProxyWithPreflight } from "@/api-app/lib/guarded-paid-proxy";

async function __hono_OPTIONS() {
  return handleCorsOptions("GET, OPTIONS");
}

async function __hono_GET(
  c: AppContext,
  { params }: { params: Promise<{ address: string }> },
) {
  const response = await executeGuardedPaidProxyWithPreflight(c, async () => {
    const { address } = await params;
    if (!isValidSolanaAddress(address)) {
      return Response.json(
        {
          error: "Invalid Solana address",
          details: "Address must be a valid base58-encoded public key",
        },
        { status: 400 },
      );
    }
    return {
      config: solanaRpcConfig,
      work: solanaRpcHandler,
      body: {
        jsonrpc: "2.0",
        id: "eliza-cloud",
        method: "getTransactionsForAddress",
        params: { address },
      },
    };
  });

  const corsHeaders = getCorsHeaders("GET, OPTIONS");
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

  return response;
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async () => __hono_OPTIONS());
__hono_app.get("/", async (c) =>
  __hono_GET(c, {
    params: Promise.resolve({ address: c.req.param("address")! }),
  }),
);
export default __hono_app;
