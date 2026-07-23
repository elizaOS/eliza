// Handles v1 cloud API v1 eliza agents agentid bridge route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import type { AgentSandbox } from "@/db/repositories/agent-sandboxes";
import { errorToResponse, ValidationError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox-bridge";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { coordinateSharedBridge } from "@/lib/services/shared-runtime/conversation-coordinator";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { BridgeExecutionContext } from "@/lib/services/shared-runtime/shared-runtime-chat";
import type {
  AppContext,
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
 * Forward a JSON-RPC request to the sandbox bridge server.
 *
 * Supported methods:
 *   - message.send  { text: string, roomId?: string }
 *   - status.get    {}
 *   - heartbeat     {}
 */
async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
  _ctx?: AppContext,
  resolved?: {
    agent: AgentSandbox;
    namespace?: RuntimeDurableObjectNamespace;
  },
) {
  try {
    const organizationId = resolved
      ? resolved.agent.organization_id
      : (await requireAuthOrApiKeyWithOrg(request)).user.organization_id;
    const { agentId } = await params;
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
    // Workers only: hand the bridge an executionCtx so the shared-tier turn can
    // defer its billing tail (billUsage → settle → analytics → audit) off the
    // response path via waitUntil. Hono's executionCtx getter THROWS outside a
    // Worker (tests, Node) — degrade to undefined there so the bridge settles
    // inline, preserving fully-synchronous behavior.
    let executionCtx: BridgeExecutionContext | undefined;
    try {
      executionCtx = _ctx?.executionCtx;
    } catch {
      // error-policy:J3 environment probe — Hono's executionCtx getter throws
      // outside a Worker; an absent ctx is the explicit "settle inline" signal.
      executionCtx = undefined;
    }
    const response = resolved
      ? await coordinateSharedBridge(resolved.agent, rpcRequest, {
          executionCtx,
          namespace: resolved.namespace,
        })
      : await import("@/lib/services/eliza-sandbox").then(
          ({ elizaSandboxService }) =>
            elizaSandboxService.bridge(
              agentId,
              organizationId,
              rpcRequest,
              executionCtx,
            ),
        );

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
  let executionCtx: BridgeExecutionContext | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    // error-policy:J3 environment probe — Hono's executionCtx getter throws
    // outside a Worker; an absent ctx is the explicit "settle inline" signal.
    executionCtx = undefined;
  }
  const scope = await resolveSharedAgent(c, {
    cacheOnly: Boolean(c.env?.SHARED_RUNTIME_CONVERSATIONS),
    executionCtx,
  });
  if ("error" in scope && scope.status === 503) {
    return applyCorsHeaders(
      Response.json(
        { success: false, error: scope.error, retryable: true },
        { status: 503, headers: { "Retry-After": "1" } },
      ),
      CORS_METHODS,
    );
  }
  return __hono_POST(
    c.req.raw,
    { params: Promise.resolve({ agentId: c.req.param("agentId")! }) },
    c,
    "agent" in scope
      ? {
          agent: scope.agent,
          namespace: c.env?.SHARED_RUNTIME_CONVERSATIONS,
        }
      : undefined,
  );
});
export default __hono_app;

export const __agentBridgeTestHooks = {
  handlePost: __hono_POST,
};
