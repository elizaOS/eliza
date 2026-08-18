/**
 * Canonical scoped SSE turn handler for cloud-hosted Eliza agent conversations.
 * Callers resolve or verify tenancy before invoking it; this core owns the
 * shared message body parsing, bridge dispatch, billing failure translation, and
 * SSE/CORS response shape used by HTTP routes and in-process voice turns.
 */

import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { InsufficientCreditsError, RateLimitError } from "../../api/errors";
import { logger } from "../../utils/logger";
import { chatSseFrame } from "../chat-sse-frames";
import type { BridgeRequest } from "../eliza-sandbox-bridge";
import { applyCorsHeaders } from "../proxy/cors";
import { coordinateSharedStream } from "./conversation-coordinator";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";
import type { BridgeExecutionContext } from "./shared-runtime-chat";
import { sharedTurnClientMessageId } from "./shared-turn-client-message-id";
import type { TrustedSharedChannelEnvelope } from "./trusted-shared-channel";

const CORS_METHODS = "POST, OPTIONS";
const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export interface CanonicalScopedStreamRequest {
  /**
   * Tenancy-resolved agent supplied by the caller. Requiring this at the type
   * boundary prevents Worker callers from falling through to the legacy
   * repository-backed bridge when cache authorization is unavailable.
   */
  agent: SharedRuntimeAgent;
  agentId: string;
  orgId: string;
  conversationId: string;
  userId?: string;
  agentKind?: "sandbox" | "personal";
  /** Set only by the authenticated in-process voice adapter for lifecycle turns. */
  trustedMessageRole?: "system";
  /** Server-owned transport provenance; body fields cannot override it. */
  trustedChannel?: TrustedSharedChannelEnvelope;
  namespace: RuntimeDurableObjectNamespace;
  executionCtx: BridgeExecutionContext;
  abortSignal?: AbortSignal;
  body: unknown;
  origin?: string | null;
  timings?: Record<string, number>;
}

function nowMs(): number {
  return performance.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

function addStreamTimingHeaders(response: Response, timings: Record<string, number>): Response {
  const headers = new Headers(response.headers);
  const entries = Object.entries(timings).filter(([, duration]) => Number.isFinite(duration));
  if (entries.length) {
    const current = entries.map(([phase, duration]) => `${phase};dur=${duration}`).join(", ");
    const upstream = headers.get("Server-Timing");
    headers.set("Server-Timing", upstream ? `${upstream}, ${current}` : current);
    for (const [phase, duration] of entries) {
      headers.set(`X-Eliza-Stream-${phase}-Ms`, String(duration));
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleCanonicalScopedAgentStream(
  request: CanonicalScopedStreamRequest,
): Promise<Response> {
  const timings = request.timings ?? {};
  const parseStartedAt = nowMs();
  const text =
    request.body &&
    typeof request.body === "object" &&
    typeof (request.body as { text?: unknown }).text === "string"
      ? (request.body as { text: string }).text
      : "";
  const clientMessageId = sharedTurnClientMessageId(request.body);
  timings.parse = elapsedMs(parseStartedAt);
  if (!text.trim()) {
    return applyCorsHeaders(
      Response.json({ success: false, error: "text is required" }, { status: 400 }),
      CORS_METHODS,
      request.origin,
    );
  }

  const rpc: BridgeRequest = {
    jsonrpc: "2.0",
    id: clientMessageId ?? crypto.randomUUID(),
    method: "message.send",
    // params.clientMessageId marks the id as CLIENT-supplied: only those enter
    // the coordinator's durable claim/replay/conflict boundary (#18045).
    params: {
      text,
      roomId: request.conversationId,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(request.userId ? { userId: request.userId } : {}),
    },
  };

  let upstream: Response;
  const bridgeStartedAt = nowMs();
  try {
    upstream = await coordinateSharedStream(request.agent, rpc, {
      abortSignal: request.abortSignal,
      namespace: request.namespace,
      executionCtx: request.executionCtx,
      agentKind: request.agentKind,
      trustedMessageRole: request.trustedMessageRole,
      trustedChannel: request.trustedChannel,
    });
    timings.bridge = elapsedMs(bridgeStartedAt);
  } catch (error) {
    timings.bridge = elapsedMs(bridgeStartedAt);
    // error-policy:J1 boundary translation — bridgeStream rejects insufficient
    // credit before any SSE bytes exist, so callers get the canonical 402 JSON.
    if (error instanceof InsufficientCreditsError) {
      logger.warn("[shared-runtime REST] stream send rejected: insufficient credits", {
        agentId: request.agentId,
      });
      return addStreamTimingHeaders(
        applyCorsHeaders(
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
        ),
        timings,
      );
    }
    if (error instanceof RateLimitError) {
      return addStreamTimingHeaders(
        applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: error.message,
              code: "rate_limit_exceeded",
              retryable: true,
            },
            {
              status: 429,
              headers: {
                "Retry-After": String(error.retryAfter ?? 60),
              },
            },
          ),
          CORS_METHODS,
          request.origin,
        ),
        timings,
      );
    }
    if (error instanceof Error && error.name === "SharedTurnConflictError") {
      // A reused clientMessageId with different text must not replace the
      // landed turn — non-retryable; the caller picks a new id (#18045).
      return addStreamTimingHeaders(
        applyCorsHeaders(
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
          request.origin,
        ),
        timings,
      );
    }
    if (error instanceof Error && error.name === "SharedRuntimeCacheWarmingError") {
      return addStreamTimingHeaders(
        applyCorsHeaders(
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
          request.origin,
        ),
        timings,
      );
    }
    throw error;
  } finally {
    logger.info("[shared-runtime REST] stream pre-header timing", {
      agentId: request.agentId,
      conversationId: request.conversationId,
      ...timings,
    });
  }

  if (!upstream.body) {
    const body = chatSseFrame("error", {
      message: "Agent produced no streamed response",
    });
    return addStreamTimingHeaders(
      applyCorsHeaders(
        new Response(body, { headers: STREAM_HEADERS }),
        CORS_METHODS,
        request.origin,
      ),
      timings,
    );
  }

  const streamHeaders = new Headers(STREAM_HEADERS);
  const upstreamTiming = upstream.headers.get("Server-Timing");
  if (upstreamTiming) streamHeaders.set("Server-Timing", upstreamTiming);

  return addStreamTimingHeaders(
    applyCorsHeaders(
      new Response(upstream.body, { headers: streamHeaders }),
      CORS_METHODS,
      request.origin,
    ),
    timings,
  );
}
