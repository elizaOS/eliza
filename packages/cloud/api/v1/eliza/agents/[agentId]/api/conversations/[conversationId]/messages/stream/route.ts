// Handles v1 cloud API v1 eliza agents agentid api conversations conversationid messages stream route traffic with route-local auth expectations.
import { Hono } from "hono";
import { InsufficientCreditsError } from "@/lib/api/errors";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * /api/v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/stream
 *
 * SSE chat for a SHARED-runtime agent. The mobile/web chat client probes this
 * `/messages/stream` endpoint first (the agent-server REST conversation contract)
 * and only falls back to the non-stream `POST .../messages` if it 404s. A shared
 * agent runs in-Worker with no agent server, so there is no upstream SSE socket to
 * proxy — instead we run the SAME billed in-Worker turn the non-stream send uses
 * (`elizaSandboxService.bridgeStream` → shared-tier branch → bridgeSharedMessageSend)
 * and emit its reply as SSE. `bridge()` (non-stream) and `bridgeStream()` share the
 * identical findRunningSandbox gate + bridgeSharedMessageSend handler, so any shared
 * agent that serves the non-stream send also serves this.
 *
 * Body shape — NOT token-by-token for the shared tier. bridgeSharedMessageSend
 * produces a fully-materialized reply string, which bridgeStream wraps in a SINGLE
 * SSE frame (one `chunk` + one `done`) via createBridgeSseTextResponse. So a shared
 * reply arrives as one buffered frame, not incrementally. DEDICATED (container)
 * agents are different: their bridgeStream branch proxies a live upstream SSE socket
 * and forwards real token-by-token frames.
 *
 * This route is a true pass-through either way: it returns the `bridgeStream`
 * Response body as-is and never awaits/reads it, so whatever the body yields
 * (single shared frame, or a dedicated agent's token stream) flushes to the
 * Cloudflare edge incrementally without buffering here.
 * Shared-tier + org-scoped (resolveSharedAgent gates auth, org-scope, tier).
 */
const CORS_METHODS = "POST, OPTIONS";
const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Defeat any intermediary buffering so SSE frames flush incrementally.
  "X-Accel-Buffering": "no",
} as const;

const app = new Hono<AppEnv>();

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

app.post("/", async (c) => {
  const origin = c.req.header("origin");
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
      origin,
    );
  }

  const conversationId = c.req.param("conversationId") ?? r.agentId;
  const raw: unknown = await c.req.json().catch(() => ({}));
  const text =
    raw &&
    typeof raw === "object" &&
    typeof (raw as { text?: unknown }).text === "string"
      ? (raw as { text: string }).text
      : "";
  if (!text.trim()) {
    return applyCorsHeaders(
      Response.json(
        { success: false, error: "text is required" },
        { status: 400 },
      ),
      CORS_METHODS,
      origin,
    );
  }

  const rpc: BridgeRequest = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message.send",
    params: { text, roomId: conversationId },
  };

  let upstream: Response | null;
  try {
    upstream = await elizaSandboxService.bridgeStream(r.agentId, r.orgId, rpc);
  } catch (error) {
    // error-policy:J1 route boundary translates pre-stream bridge failures to HTTP responses.
    // Insufficient credits is rejected before any SSE bytes exist, so answer
    // with the same canonical 402 as the non-stream send — not an SSE error
    // frame inside a 200 stream, which the app cannot distinguish from a
    // transient turn failure. Permanent until the org adds credits.
    if (error instanceof InsufficientCreditsError) {
      logger.warn(
        "[shared-runtime REST] stream send rejected: insufficient credits",
        { agentId: r.agentId },
      );
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: error.message,
            code: "insufficient_credits",
            retryable: false,
          },
          { status: 402 },
        ),
        CORS_METHODS,
        origin,
      );
    }
    throw error;
  }
  if (!upstream?.body) {
    // No reply produced (or the turn errored without an SSE body): emit an SSE
    // error frame the client's stream reader understands, instead of a 404 that
    // would make the client treat the whole stream endpoint as missing.
    const body = `event: error\ndata: ${JSON.stringify({
      message: "Agent produced no streamed response",
    })}\n\n`;
    return applyCorsHeaders(
      new Response(body, { headers: STREAM_HEADERS }),
      CORS_METHODS,
      origin,
    );
  }

  // Return the bridge SSE body as-is — do NOT await/read it here. A shared-tier
  // body is a single pre-built frame; a dedicated agent's is a live token stream.
  // Either way the route forwards it untouched and the edge flushes incrementally.
  return applyCorsHeaders(
    new Response(upstream.body, { headers: STREAM_HEADERS }),
    CORS_METHODS,
    origin,
  );
});

export default app;
