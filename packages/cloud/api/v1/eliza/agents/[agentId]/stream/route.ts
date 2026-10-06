/**
 * Streams shared-agent JSON-RPC turns from the conversation Durable Object.
 *
 * Worker bindings and cache-authorized agent scope are mandatory; the route
 * never falls through to a repository-backed sandbox stream.
 */

import {
  errorToResponse,
  ValidationError,
} from "@elizaos/cloud-shared/lib/api/errors";
import { chatSseFrame } from "@elizaos/cloud-shared/lib/services/chat-sse-frames";
import type { BridgeRequest } from "@elizaos/cloud-shared/lib/services/eliza-sandbox";
import {
  personalDirectChatRefusalResponse,
  resolveSharedSurfaceTarget,
} from "@elizaos/cloud-shared/lib/services/personal-direct-chat-route";
import {
  applyCorsHeaders,
  handleCorsOptions,
} from "@elizaos/cloud-shared/lib/services/proxy/cors";
import { coordinateSharedStream } from "@elizaos/cloud-shared/lib/services/shared-runtime/conversation-coordinator";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@elizaos/cloud-shared/lib/services/shared-runtime/resolve-shared-agent";
import type { SharedRuntimeAgent } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-agent";
import type { BridgeExecutionContext } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-chat";
import type {
  AppEnv,
  RuntimeDurableObjectNamespace,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

// Streaming responses can be long-running

const CORS_METHODS = "POST, OPTIONS";
const STREAM_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const streamRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.literal("message.send"),
  params: z
    .object({
      text: z.string().min(1),
      roomId: z.string().optional(),
      mode: z.enum(["simple", "power"]).optional(),
    })
    .passthrough(),
});

/**
 * POST /api/v1/eliza/agents/[agentId]/stream
 * Forward a message to the shared conversation coordinator as SSE events.
 *
 * Events:
 *   connected  - initial connection established
 *   chunk      - a piece of the agent's response text
 *   done       - response is complete
 *   error      - an error occurred
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

    const parsed = streamRequestSchema.safeParse(body);
    if (!parsed.success) {
      return applyCorsHeaders(
        new Response(
          JSON.stringify({
            error: "Invalid request",
            details: parsed.error.issues,
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
        CORS_METHODS,
      );
    }

    let rpcRequest = parsed.data as BridgeRequest;
    // A personal turn follows its entitlement route (#25146): Dedicated
    // ownership is refused with its agent id, and a withdrawn Dedicated is
    // answered in the scoped fallback journal with the account state.
    let trustedAccountState:
      | Extract<
          Awaited<ReturnType<typeof resolveSharedSurfaceTarget>>,
          { ok: true }
        >["accountState"]
      | undefined;
    if (resolved.agentKind === "personal") {
      const requestedRoom = parsed.data.params.roomId;
      const target = await resolveSharedSurfaceTarget({
        agent: resolved.agent,
        personal: true,
        conversationId: requestedRoom?.trim()
          ? requestedRoom
          : resolved.agent.id,
        namespace: resolved.namespace,
      });
      if (!target.ok) {
        const refusal = personalDirectChatRefusalResponse(target.refusal);
        return applyCorsHeaders(
          Response.json(refusal.body, {
            status: refusal.status,
            headers: refusal.headers,
          }),
          CORS_METHODS,
        );
      }
      if (target.accountState) {
        trustedAccountState = target.accountState;
        rpcRequest = {
          ...rpcRequest,
          params: { ...rpcRequest.params, roomId: target.roomId },
        };
      }
    }

    const upstreamResponse = await coordinateSharedStream(
      resolved.agent,
      rpcRequest,
      {
        abortSignal: request.signal,
        executionCtx: resolved.executionCtx,
        namespace: resolved.namespace,
        agentKind: resolved.agentKind,
        trustedUserUtterance: parsed.data.params.text,
        ...(trustedAccountState ? { trustedAccountState } : {}),
      },
    );

    if (!upstreamResponse.body) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Send error as SSE then close
      (async () => {
        await writer.write(
          encoder.encode(
            chatSseFrame("error", {
              message: "Sandbox is not running or unreachable",
            }),
          ),
        );
        await writer.close();
      })();

      return applyCorsHeaders(
        new Response(readable, {
          headers: {
            ...STREAM_HEADERS,
          },
        }),
        CORS_METHODS,
      );
    }

    // Proxy the upstream SSE stream directly to the client.
    // The sandbox bridge/stream endpoint already emits proper SSE events
    // (connected, chunk, done), so we just pipe the body through.
    return applyCorsHeaders(
      new Response(upstreamResponse.body, {
        headers: STREAM_HEADERS,
      }),
      CORS_METHODS,
    );
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
          ...(scope.code ? { code: scope.code } : {}),
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
      ...("agentKind" in scope ? { agentKind: scope.agentKind } : {}),
      namespace: worker.namespace,
      executionCtx: worker.executionCtx,
    },
  );
});
export default __hono_app;

export const __agentStreamTestHooks = {
  handlePost: __hono_POST,
};
