/**
 * Shared paid-legacy-proxy adapter. One standing read via
 * requireGenerativeRouteCaller, then the engine consumes that snapshot and
 * credential. Combined Worker mode never falls back to generic auth or a
 * second reserve path.
 */

import {
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import type { ProxyCombinedAdmission } from "@/lib/services/proxy/engine";
import { executeWithBody } from "@/lib/services/proxy/engine";
import type {
  ProxyRequestBody,
  ServiceConfig,
  ServiceHandler,
} from "@/lib/services/proxy/types";
import type { AppContext } from "@/types/cloud-worker-env";

export const PAID_LEGACY_PROXY_EXECUTE_ROUTES = [
  "v1/chain/nfts/[chain]/[address]/route.ts",
  "v1/chain/tokens/[chain]/[address]/route.ts",
  "v1/chain/transfers/[chain]/[address]/route.ts",
  "v1/market/candles/[chain]/[address]/route.ts",
  "v1/market/portfolio/[chain]/[address]/route.ts",
  "v1/market/price/[chain]/[address]/route.ts",
  "v1/market/token/[chain]/[address]/route.ts",
  "v1/market/trades/[chain]/[address]/route.ts",
  "v1/proxy/evm-rpc/[chain]/route.ts",
  "v1/proxy/solana-rpc/route.ts",
  "v1/solana/assets/[address]/route.ts",
  "v1/solana/rpc/route.ts",
  "v1/solana/token-accounts/[address]/route.ts",
  "v1/solana/transactions/[address]/route.ts",
] as const;

export const PAID_LEGACY_PROXY_BIRDEYE_ROUTE =
  "v1/apis/birdeye/[...path]/route.ts" as const;

export const PAID_LEGACY_PROXY_RPC_ROUTE = "v1/rpc/[chain]/route.ts" as const;

export const EXEMPT_LEGACY_PROXY_ROUTES = [
  "v1/proxy/birdeye/[...path]/route.ts",
] as const;

export function applyLegacyProxyQueryApiKey(c: AppContext): Headers {
  const headers = new Headers(c.req.raw.headers);
  const queryApiKey = c.req.query("api_key");
  if (
    queryApiKey &&
    !c.req.header("authorization") &&
    !c.req.header("X-API-Key")
  ) {
    headers.set("authorization", `Bearer ${queryApiKey}`);
    try {
      c.req.raw.headers.set("authorization", `Bearer ${queryApiKey}`);
    } catch {
      // error-policy:J4 immutable Worker headers still reach the cloned Request
      // used for engine dispatch; standing reads the mutated copy when allowed.
    }
  }
  return headers;
}

export async function resolvePaidProxyCombinedAdmission(
  c: AppContext,
): Promise<ProxyCombinedAdmission> {
  const caller = await requireGenerativeRouteCaller(c, {
    rateLimitEndpoint: "standard",
  });
  const executionCtx = getGenerativeExecutionContext(c);
  if (executionCtx && !caller.admissionSnapshot) {
    throw new ApiError(
      503,
      "service_unavailable",
      "Provider admission is unavailable; retry shortly",
      { retryable: true, retryAfterSeconds: 1 },
    );
  }
  return {
    auth: {
      user: caller.user,
      ...(caller.apiKeyId ? { apiKey: { id: caller.apiKeyId } } : {}),
    },
    admissionSnapshot: caller.admissionSnapshot,
    executionCtx,
    requestId: c.get("requestId") ?? c.get("traceId") ?? crypto.randomUUID(),
  };
}

export async function executePaidProxyWithCombinedAdmission(
  c: AppContext,
  config: ServiceConfig,
  work: ServiceHandler,
  request: Request,
  body: ProxyRequestBody,
): Promise<Response> {
  try {
    const combinedAdmission = await resolvePaidProxyCombinedAdmission(c);
    return await executeWithBody(
      config,
      work,
      request,
      body,
      combinedAdmission,
    );
  } catch (error) {
    const mapped = asGenerativeCacheApiError(error) ?? error;
    if (mapped instanceof ApiError && mapped.status === 503) {
      const response = failureResponse(c, mapped);
      response.headers.set("Retry-After", "1");
      return response;
    }
    return failureResponse(c, mapped);
  }
}
