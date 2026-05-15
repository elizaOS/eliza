import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { createHandler } from "@/lib/services/proxy/engine";
import {
  isValidRpcChain,
  rpcConfigForChain,
  rpcHandlerForChain,
  SUPPORTED_RPC_CHAINS,
} from "@/lib/services/proxy/services/rpc";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

async function __hono_OPTIONS() {
  return handleCorsOptions(CORS_METHODS);
}

async function __hono_POST(request: Request, { params }: { params: Promise<{ chain: string }> }) {
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
  const handler = createHandler(config, rpcHandlerForChain(normalized));
  return applyCorsHeaders(await handler(request), CORS_METHODS);
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async () => __hono_OPTIONS());
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ chain: c.req.param("chain")! }) }),
);
export default __hono_app;
