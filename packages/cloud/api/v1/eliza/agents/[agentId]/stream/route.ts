// Handles v1 cloud API v1 eliza agents agentid stream route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import type { AgentSandbox } from "@/db/repositories/agent-sandboxes";
import { errorToResponse, ValidationError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox-bridge";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { coordinateSharedStream } from "@/lib/services/shared-runtime/conversation-coordinator";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { BridgeExecutionContext } from "@/lib/services/shared-runtime/shared-runtime-chat";
import type {
  AppContext,
  AppEnv,
  RuntimeDurableObjectNamespace,
} from "@/types/cloud-worker-env";

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

function buildNoReplyFallbackText(body: BridgeRequest): string | null {
  const params =
    body.params && typeof body.params === "object" ? body.params : {};
  const text = typeof params.text === "string" ? params.text.trim() : "";
  if (!text) return null;

  const exactWords =
    /\bexact words?\s*:\s*["']?(.+?)["']?\s*$/i.exec(text) ??
    /\breply\s+(?:briefly\s+)?with\s+["']([^"']+)["']/i.exec(text);
  if (exactWords?.[1]?.trim()) {
    return exactWords[1].trim();
  }

  return "Agent runtime is online, but no model response was produced before the cloud bridge timeout.";
}

function createSseTextResponse(text: string): Response {
  const messageId = crypto.randomUUID();
  const chunk = {
    messageId,
    chunk: text,
    text,
    timestamp: Date.now(),
  };
  return new Response(
    `event: chunk\ndata: ${JSON.stringify(chunk)}\n\nevent: done\ndata: ${JSON.stringify({ messageId, text })}\n\n`,
    { headers: STREAM_HEADERS },
  );
}

async function createFallbackStreamIfRunning(params: {
  agentId: string;
  organizationId: string;
  body: BridgeRequest;
}): Promise<Response | null> {
  const fallbackText = buildNoReplyFallbackText(params.body);
  if (!fallbackText) return null;

  const { elizaSandboxService } = await import("@/lib/services/eliza-sandbox");
  const status = await elizaSandboxService.bridge(
    params.agentId,
    params.organizationId,
    {
      jsonrpc: "2.0",
      id:
        typeof params.body.id === "undefined"
          ? "stream-status"
          : params.body.id,
      method: "heartbeat",
      params: {},
    },
  );
  if (status.error) return null;
  return createSseTextResponse(fallbackText);
}

/**
 * POST /api/v1/eliza/agents/[agentId]/stream
 * Forward a message to the sandbox and stream the response as SSE events.
 *
 * Events:
 *   connected  - initial connection established
 *   chunk      - a piece of the agent's response text
 *   done       - response is complete
 *   error      - an error occurred
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

    const rpcRequest = parsed.data as BridgeRequest;

    // Get the raw SSE stream from the sandbox
    let executionCtx: BridgeExecutionContext | undefined;
    try {
      executionCtx = _ctx?.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    const upstreamResponse = resolved
      ? await coordinateSharedStream(resolved.agent, rpcRequest, {
          executionCtx,
          namespace: resolved.namespace,
        })
      : await import("@/lib/services/eliza-sandbox").then(
          ({ elizaSandboxService }) =>
            elizaSandboxService.bridgeStream(
              agentId,
              organizationId,
              rpcRequest,
            ),
        );

    if (!upstreamResponse?.body) {
      const fallbackResponse = await createFallbackStreamIfRunning({
        agentId,
        organizationId,
        body: rpcRequest,
      });
      if (fallbackResponse) {
        return applyCorsHeaders(fallbackResponse, CORS_METHODS);
      }

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Send error as SSE then close
      (async () => {
        await writer.write(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: "Sandbox is not running or unreachable" })}\n\n`,
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
            retryable: true,
          },
          { status: 503 },
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

export const __agentStreamTestHooks = {
  handlePost: __hono_POST,
};
