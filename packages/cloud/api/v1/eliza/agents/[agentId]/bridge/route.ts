/**
 * Dispatches shared-agent JSON-RPC requests to the conversation Durable Object.
 *
 * Worker bindings and cache-authorized agent scope are mandatory; the route
 * never falls through to a repository-backed sandbox bridge.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AgentSandbox } from "@/db/repositories/agent-sandboxes";
import { errorToResponse, ValidationError } from "@/lib/api/errors";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox-bridge";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { coordinateSharedBridge } from "@/lib/services/shared-runtime/conversation-coordinator";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { BridgeExecutionContext } from "@/lib/services/shared-runtime/shared-runtime-chat";
import type {
  AppEnv,
  RuntimeDurableObjectNamespace,
} from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

const bridgeRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /api/v1/eliza/agents/[agentId]/bridge
 * Forward a JSON-RPC request to the shared conversation coordinator.
 *
 * Supported methods:
 *   - message.send  { text: string, roomId?: string }
 *   - status.get    {}
 *   - heartbeat     {}
 */
async function __hono_POST(
  request: Request,
  _route: { params: Promise<{ agentId: string }> },
  resolved: {
    agent: AgentSandbox;
    namespace: RuntimeDurableObjectNamespace;
    executionCtx: BridgeExecutionContext;
  },
) {
  try {
    // A missing/malformed JSON body is caller error: a typed 400, not the
    // unguarded SyntaxError that errorToResponse maps to a 500.
    const body = await request.json().catch(() => {
      // error-policy:J3 untrusted request body — malformed JSON becomes a typed 400 "invalid" result
      throw new ValidationError("Invalid JSON body");
    });

    const parsed = bridgeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Invalid JSON-RPC request",
            details: parsed.error.issues,
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }

    const rpcRequest = parsed.data as BridgeRequest;
    const response = await coordinateSharedBridge(resolved.agent, rpcRequest, {
      executionCtx: resolved.executionCtx,
      namespace: resolved.namespace,
    });

    return applyCorsHeaders(Response.json(response), CORS_METHODS);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "SharedRuntimeCacheWarmingError"
    ) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: error.message,
            retryable: true,
          },
          { status: 503, headers: { "Retry-After": "1" } },
        ),
        CORS_METHODS,
      );
    }
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) => {
  const worker = resolveSharedRuntimeWorkerRequestContext(c);
  if ("error" in worker) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: worker.error,
          code: worker.code,
          retryable: worker.retryable,
        },
        { status: worker.status, headers: { "Retry-After": "1" } },
      ),
      CORS_METHODS,
    );
  }
  const scope = await resolveSharedAgent(c, {
    cacheOnly: true,
    executionCtx: worker.executionCtx,
  });
  if ("error" in scope) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: scope.error,
          ...(scope.status === 503 ? { retryable: true } : {}),
        },
        {
          status: scope.status,
          ...(scope.status === 503 ? { headers: { "Retry-After": "1" } } : {}),
        },
      ),
      CORS_METHODS,
    );
  }
  return __hono_POST(
    c.req.raw,
    { params: Promise.resolve({ agentId: c.req.param("agentId")! }) },
    {
      agent: scope.agent,
      namespace: worker.namespace,
      executionCtx: worker.executionCtx,
    },
  );
});
export default __hono_app;

export const __agentBridgeTestHooks = {
  handlePost: __hono_POST,
};
