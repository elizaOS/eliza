import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

// Streaming responses can be long-running

const CORS_METHODS = "POST, OPTIONS";

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

const CONTROL_PLANE_URL_KEYS = [
  "CONTAINER_CONTROL_PLANE_URL",
  "CONTAINER_SIDECAR_URL",
  "HETZNER_CONTAINER_CONTROL_PLANE_URL",
] as const;

function readControlPlaneEnv(c: AppContext | undefined, keys: readonly string[]): string | null {
  if (!c?.env) return null;
  for (const key of keys) {
    const value = c.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function forwardStreamToControlPlane(params: {
  ctx?: AppContext;
  request: Request;
  agentId: string;
  user: { id: string; organization_id: string };
  body: BridgeRequest;
}): Promise<Response | null> {
  const baseUrl = readControlPlaneEnv(params.ctx, CONTROL_PLANE_URL_KEYS);
  if (!baseUrl) return null;

  const target = new URL(baseUrl);
  target.pathname = `/api/v1/eliza/agents/${encodeURIComponent(params.agentId)}/stream`;

  const headers = new Headers(params.request.headers);
  headers.delete("host");
  const internalToken = readControlPlaneEnv(params.ctx, ["CONTAINER_CONTROL_PLANE_TOKEN"]);
  if (internalToken) headers.set("x-container-control-plane-token", internalToken);
  const databaseUrl = readControlPlaneEnv(params.ctx, ["DATABASE_URL"]);
  if (databaseUrl) headers.set("x-eliza-cloud-database-url", databaseUrl);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  headers.set("x-eliza-user-id", params.user.id);
  headers.set("x-eliza-organization-id", params.user.organization_id);

  return fetch(target, {
    method: "POST",
    headers,
    body: JSON.stringify(params.body),
    redirect: "manual",
    signal: AbortSignal.timeout(130_000),
  });
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
  ctx?: AppContext,
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const body = await request.json();

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
    const upstreamResponse = await elizaSandboxService.bridgeStream(
      agentId,
      user.organization_id,
      rpcRequest,
    );

    if (!upstreamResponse || !upstreamResponse.body) {
      const forwarded = await forwardStreamToControlPlane({
        ctx,
        request,
        agentId,
        user,
        body: rpcRequest,
      });
      if (forwarded) {
        return applyCorsHeaders(forwarded, CORS_METHODS);
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
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
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
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      }),
      CORS_METHODS,
    );
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ agentId: c.req.param("agentId")! }) }, c),
);
export default __hono_app;
