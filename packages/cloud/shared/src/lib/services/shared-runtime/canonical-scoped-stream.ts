/**
 * Canonical scoped SSE turn handler for cloud-hosted Eliza agent conversations.
 * Callers resolve or verify tenancy before invoking it; this core owns the
 * shared message body parsing, bridge dispatch, billing failure translation, and
 * SSE/CORS response shape used by HTTP routes and in-process voice turns.
 */
import { InsufficientCreditsError } from "../../api/errors";
import { logger } from "../../utils/logger";
import type { BridgeRequest } from "../eliza-sandbox";
import { elizaSandboxService } from "../eliza-sandbox";
import { applyCorsHeaders } from "../proxy/cors";

const CORS_METHODS = "POST, OPTIONS";
const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export interface CanonicalScopedStreamRequest {
  agentId: string;
  orgId: string;
  conversationId: string;
  body: unknown;
  origin?: string | null;
}

export async function handleCanonicalScopedAgentStream(
  request: CanonicalScopedStreamRequest,
): Promise<Response> {
  const text =
    request.body &&
    typeof request.body === "object" &&
    typeof (request.body as { text?: unknown }).text === "string"
      ? (request.body as { text: string }).text
      : "";
  if (!text.trim()) {
    return applyCorsHeaders(
      Response.json({ success: false, error: "text is required" }, { status: 400 }),
      CORS_METHODS,
      request.origin,
    );
  }

  const rpc: BridgeRequest = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message.send",
    params: { text, roomId: request.conversationId },
  };

  let upstream: Response | null;
  try {
    upstream = await elizaSandboxService.bridgeStream(request.agentId, request.orgId, rpc);
  } catch (error) {
    // error-policy:J1 boundary translation — bridgeStream rejects insufficient
    // credit before any SSE bytes exist, so callers get the canonical 402 JSON.
    if (error instanceof InsufficientCreditsError) {
      logger.warn("[shared-runtime REST] stream send rejected: insufficient credits", {
        agentId: request.agentId,
      });
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
        request.origin,
      );
    }
    throw error;
  }

  if (!upstream?.body) {
    const body = `event: error\ndata: ${JSON.stringify({
      message: "Agent produced no streamed response",
    })}\n\n`;
    return applyCorsHeaders(
      new Response(body, { headers: STREAM_HEADERS }),
      CORS_METHODS,
      request.origin,
    );
  }

  return applyCorsHeaders(
    new Response(upstream.body, { headers: STREAM_HEADERS }),
    CORS_METHODS,
    request.origin,
  );
}
