/**
 * Dispatches shared-agent JSON-RPC requests to the conversation Durable Object.
 *
 * Serves BOTH tiers. Shared agents go to the conversation Durable Object; a
 * dedicated agent — which the shared resolver refuses by design — is dispatched
 * to its own container bridge. Losing that second branch is what 404'd every
 * dedicated agent between 2026-07-23 and #18062.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse, ValidationError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { resolveElizaTraceId } from "@/lib/observability/http-telemetry";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox-bridge";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { coordinateSharedBridge } from "@/lib/services/shared-runtime/conversation-coordinator";
import { isPersonalSharedAgentId } from "@/lib/services/shared-runtime/personal-shared-agent";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { SharedRuntimeAgent } from "@/lib/services/shared-runtime/shared-runtime-agent";
import type { BridgeExecutionContext } from "@/lib/services/shared-runtime/shared-runtime-chat";
import {
  classifyBridgeRequestMethod,
  classifySharedTurnOutcome,
  recordSharedTurnAttempt,
  type SharedTurnRuntimeKind,
} from "@/lib/services/shared-runtime/shared-turn-observability";
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
    agent: SharedRuntimeAgent;
    agentKind?: "sandbox" | "personal";
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
      agentKind: resolved.agentKind,
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
            code: "shared_runtime_cache_warming",
            retryable: true,
          },
          { status: 503, headers: { "Retry-After": "1" } },
        ),
        CORS_METHODS,
      );
    }
    // A reused clientMessageId with different text must not replace the landed
    // turn — non-retryable; the caller picks a new id (#18045).
    if (error instanceof Error && error.name === "SharedTurnConflictError") {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: error.message,
            code: "client_message_conflict",
            retryable: false,
          },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

/**
 * Forward a JSON-RPC request to a dedicated agent's own container bridge.
 *
 * Authorization is re-derived here rather than inherited: the shared resolver
 * refused this agent, so it produced no authorized scope to reuse.
 * `elizaSandboxService.bridge` is org-scoped, so the organization must come
 * from the request's own credential.
 */
async function dispatchToDedicatedSandbox(
  c: Context<AppEnv>,
  executionCtx: BridgeExecutionContext,
): Promise<Response> {
  try {
    const body = await c.req.raw.json().catch(() => {
      // error-policy:J3 untrusted request body — malformed JSON becomes a typed 400
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
    const { user } = await requireAuthOrApiKeyWithOrg(c.req.raw);
    const response = await elizaSandboxService.bridge(
      c.req.param("agentId")!,
      user.organization_id,
      parsed.data as BridgeRequest,
      executionCtx,
    );
    return applyCorsHeaders(Response.json(response), CORS_METHODS);
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) => {
  const startedAt = performance.now();
  const headers = c.req.raw.headers;
  const traceId = c.get("traceId") ?? resolveElizaTraceId(headers);
  const rpcMethodPromise = classifyBridgeRequestMethod(c.req.raw);
  const unresolvedRuntimeKind: SharedTurnRuntimeKind = isPersonalSharedAgentId(
    c.req.param("agentId") ?? "",
  )
    ? "personal"
    : "unresolved";
  const dispatch = async (): Promise<{
    response: Response;
    runtimeKind: SharedTurnRuntimeKind;
  }> => {
    const worker = resolveSharedRuntimeWorkerRequestContext(c);
    if ("error" in worker) {
      return {
        response: applyCorsHeaders(
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
        ),
        runtimeKind: unresolvedRuntimeKind,
      };
    }
    const scope = await resolveSharedAgent(c, {
      cacheOnly: true,
      executionCtx: worker.executionCtx,
    });
    if ("error" in scope) {
      // A dedicated agent is not a client error here — this route serves both
      // tiers, and the shared resolver refusing it is the signal to take the
      // sandbox path. #17076 collapsed this branch, so the internal discriminator
      // escaped to callers as a terminal 404 (#18062).
      if (scope.refusal === "dedicated-agent") {
        return {
          response: await dispatchToDedicatedSandbox(c, worker.executionCtx),
          runtimeKind: "dedicated",
        };
      }
      return {
        response: applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: scope.error,
              ...(scope.code ? { code: scope.code } : {}),
              ...(scope.status === 503 ? { retryable: true } : {}),
            },
            {
              status: scope.status,
              ...(scope.status === 503
                ? { headers: { "Retry-After": "1" } }
                : {}),
            },
          ),
          CORS_METHODS,
        ),
        runtimeKind: unresolvedRuntimeKind,
      };
    }
    return {
      response: await __hono_POST(
        c.req.raw,
        { params: Promise.resolve({ agentId: c.req.param("agentId")! }) },
        {
          agent: scope.agent,
          ...("agentKind" in scope ? { agentKind: scope.agentKind } : {}),
          namespace: worker.namespace,
          executionCtx: worker.executionCtx,
        },
      ),
      runtimeKind:
        "agentKind" in scope && scope.agentKind === "personal"
          ? "personal"
          : "sandbox",
    };
  };

  const [{ response, runtimeKind }, rpcMethod] = await Promise.all([
    dispatch(),
    rpcMethodPromise,
  ]);
  const outcome = await classifySharedTurnOutcome(response);
  recordSharedTurnAttempt({
    headers,
    traceId,
    durationMs: performance.now() - startedAt,
    surface: "bridge",
    rpcMethod,
    runtimeKind,
    status: response.status,
    outcome,
  });
  return response;
});
export default __hono_app;

export const __agentBridgeTestHooks = {
  handlePost: __hono_POST,
};
