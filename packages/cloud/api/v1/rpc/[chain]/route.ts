// Handles v1 cloud API v1 rpc chain route traffic with route-local auth expectations.
import { Hono } from "hono";
import {
  getGenerativeExecutionContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { createHandler } from "@/lib/services/proxy/engine";
import {
  isValidRpcChain,
  rpcConfigForChain,
  rpcHandlerForChain,
  SUPPORTED_RPC_CHAINS,
} from "@/lib/services/proxy/services/rpc";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

async function __hono_OPTIONS() {
  return handleCorsOptions(CORS_METHODS);
}

async function __hono_POST(
  c: AppContext,
  { params }: { params: Promise<{ chain: string }> },
) {
  const { chain } = await params;
  const normalized = chain.toLowerCase();

  if (!isValidRpcChain(normalized)) {
    return applyCorsHeaders(
      Response.json(
        { error: "Unsupported chain", supported: [...SUPPORTED_RPC_CHAINS] },
        { status: 400 },
      ),
      CORS_METHODS,
    );
  }

  const config = rpcConfigForChain(normalized);
  const caller = await requireGenerativeRouteCaller(c, {
    rateLimitEndpoint: "standard",
  });
  const executionCtx = getGenerativeExecutionContext(c);
  if (executionCtx && !caller.admissionSnapshot) {
    return applyCorsHeaders(
      Response.json(
        { error: "Provider admission is unavailable; retry shortly" },
        { status: 503, headers: { "Retry-After": "1" } },
      ),
      CORS_METHODS,
    );
  }
  const handler = createHandler(config, rpcHandlerForChain(normalized), {
    auth: {
      user: caller.user,
      ...(caller.apiKeyId ? { apiKey: { id: caller.apiKeyId } } : {}),
    },
    admissionSnapshot: caller.admissionSnapshot,
    executionCtx,
    requestId: c.get("requestId") ?? c.get("traceId") ?? crypto.randomUUID(),
  });
  return applyCorsHeaders(await handler(c.req.raw), CORS_METHODS);
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async () => __hono_OPTIONS());
__hono_app.post("/", async (c) =>
  __hono_POST(c, {
    params: Promise.resolve({ chain: c.req.param("chain")! }),
  }),
);
export default __hono_app;
