// Handles v1 cloud API v1 rpc chain route traffic with route-local auth expectations.
import { Hono } from "hono";
import {
  executeGuardedPaidProxyRequest,
  withGuardedPaidProxyAdmission,
} from "@/api-app/lib/guarded-paid-proxy";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
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

  const chainIsValid = isValidRpcChain(normalized);
  const pendingResponse = !chainIsValid
    ? Response.json(
        { error: "Unsupported chain", supported: [...SUPPORTED_RPC_CHAINS] },
        { status: 400 },
      )
    : undefined;

  if (pendingResponse) {
    return applyCorsHeaders(
      await withGuardedPaidProxyAdmission(c, async () => pendingResponse, {
        deferStrongCredentialCheck: false,
      }),
      CORS_METHODS,
    );
  }
  return applyCorsHeaders(
    await executeGuardedPaidProxyRequest(
      c,
      rpcConfigForChain(normalized),
      rpcHandlerForChain(normalized),
    ),
    CORS_METHODS,
  );
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async () => __hono_OPTIONS());
__hono_app.post("/", async (c) =>
  __hono_POST(c, {
    params: Promise.resolve({ chain: c.req.param("chain")! }),
  }),
);
export default __hono_app;
