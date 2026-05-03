import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

// Streaming responses can be long-running

const CORS_METHODS = "POST, OPTIONS";

const streamRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.literal("message.send"),
  params: z.object({
    text: z.string().min(1),
    roomId: z.string().optional(),
  }),
});

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
async function __hono_POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
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
  __hono_POST(c.req.raw, { params: Promise.resolve({ agentId: c.req.param("agentId")! }) }),
);
export default __hono_app;
