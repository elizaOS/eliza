/**
 * Canonical scoped SSE turn handler for cloud-hosted Eliza agent conversations.
 * Callers resolve or verify tenancy before invoking it; this core owns the
 * shared message body parsing, bridge dispatch, billing failure translation, and
 * SSE/CORS response shape used by HTTP routes and in-process voice turns.
 */

import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { InsufficientCreditsError } from "../../api/errors";
import { logger } from "../../utils/logger";
import type { BridgeRequest } from "../eliza-sandbox-bridge";
import { applyCorsHeaders } from "../proxy/cors";
import { coordinateSharedStream } from "./conversation-coordinator";
import type { BridgeExecutionContext } from "./shared-runtime-chat";

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
  userId?: string;
  agent?: AgentSandbox;
  namespace?: RuntimeDurableObjectNamespace;
  /**
   * Workers only: lets the shared-tier turn defer its billing tail off the
   * SSE `done` path via executionCtx.waitUntil. Absent (tests, non-Worker
   * callers) the tail settles inline as before.
   */
  executionCtx?: BridgeExecutionContext;
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
    headers.set(
      "Server-Timing",
      entries.map(([phase, duration]) => `${phase};dur=${duration}`).join(", "),
    );
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
    id: crypto.randomUUID(),
    method: "message.send",
    params: {
      text,
      roomId: request.conversationId,
      ...(request.userId ? { userId: request.userId, source: "voice" } : {}),
    },
  };

  let upstream: Response | null;
  const bridgeStartedAt = nowMs();
  try {
    upstream = request.agent
      ? await coordinateSharedStream(request.agent, rpc, {
          namespace: request.namespace,
          executionCtx: request.executionCtx,
        })
      : await import("../eliza-sandbox").then(({ elizaSandboxService }) =>
          elizaSandboxService.bridgeStream(
            request.agentId,
            request.orgId,
            rpc,
            request.executionCtx,
          ),
        );
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
            { status: 503 },
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

  if (!upstream?.body) {
    const body = `event: error\ndata: ${JSON.stringify({
      message: "Agent produced no streamed response",
    })}\n\n`;
    return addStreamTimingHeaders(
      applyCorsHeaders(
        new Response(body, { headers: STREAM_HEADERS }),
        CORS_METHODS,
        request.origin,
      ),
      timings,
    );
  }

  return addStreamTimingHeaders(
    applyCorsHeaders(
      new Response(upstream.body, { headers: STREAM_HEADERS }),
      CORS_METHODS,
      request.origin,
    ),
    timings,
  );
}
