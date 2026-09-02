// Handles v1 cloud API v1 solana assets address route traffic with route-local auth expectations.
import { Hono } from "hono";

import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * Solana Assets API - Get assets by owner address
 *
 * Public API for retrieving Solana NFTs and tokens owned by an address.
 *
 * CORS: Unrestricted by design - see lib/services/proxy/cors.ts for security rationale.
 * Authentication: API key required (X-API-Key header)
 * Rate Limiting: Per API key
 */

import { executeGuardedPaidProxyWithPreflight } from "@/api-app/lib/guarded-paid-proxy";
import { getCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  solanaRpcConfig,
  solanaRpcHandler,
} from "@/lib/services/proxy/services/solana-rpc";
import { isValidSolanaAddress } from "@/lib/services/proxy/services/solana-validation";

async function __hono_OPTIONS() {
  return handleCorsOptions("GET, OPTIONS");
}

async function __hono_GET(
  c: AppContext,
  { params }: { params: Promise<{ address: string }> },
) {
  const corsHeaders = getCorsHeaders("GET, OPTIONS");
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
        method: "getAssetsByOwner",
        params: { ownerAddress: address, page: 1, limit: 1000 },
      },
    };
  });

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
