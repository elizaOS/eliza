/**
 * Serves shared-agent REST conversation history and message sends.
 *
 * Scope authorization and conversation execution are cache-only through the
 * shared Durable Object; cold hydration returns retryable unavailability.
 */
import { Hono } from "hono";
import { InsufficientCreditsError, RateLimitError } from "@/lib/api/errors";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestMessageSend,
  sharedRestMessagesGet,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import { sharedTurnClientMessageId } from "@/lib/services/shared-runtime/shared-runtime-chat";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { proxyLocalDedicatedOrNext } from "../../../_local-dedicated-proxy";

/**
 * /api/v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages
 *
 * REST chat for a SHARED-runtime agent. GET returns the persisted turn history
 * (read from the bridge's KV channel); POST forwards the user text to the shared
 * bridge `message.send` (which runs the turn, persists history, and bills) and
 * returns the assistant reply. Shared-tier + org-scoped.
 */
const CORS_METHODS = "GET, POST, OPTIONS";

const app = new Hono<AppEnv>();

app.use("*", proxyLocalDedicatedOrNext);

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

app.get("/", async (c) => {
  const origin = c.req.header("origin");
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
        { status: worker.status },
      ),
      CORS_METHODS,
      origin,
    );
  }
  const r = await resolveSharedAgent(c, {
    cacheOnly: true,
    executionCtx: worker.executionCtx,
  });
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: r.error,
          ...(r.code ? { code: r.code } : {}),
          ...(r.status === 503 ? { retryable: true } : {}),
        },
        {
          status: r.status,
          ...(r.retryAfterSeconds
            ? { headers: { "Retry-After": String(r.retryAfterSeconds) } }
            : {}),
        },
      ),
      CORS_METHODS,
      origin,
    );
  }
  const conversationId = c.req.param("conversationId") ?? r.agentId;
  try {
    const body = await sharedRestMessagesGet(
      r.agentId,
      conversationId,
      worker.namespace,
    );
    return applyCorsHeaders(Response.json(body), CORS_METHODS, origin);
  } catch (error) {
    // error-policy:J1 history is coordinator-owned, so a cold Durable Object
    // remains a retryable response instead of surfacing as an opaque route 500.
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
        origin,
      );
    }
    throw error;
  }
});

app.post("/", async (c) => {
  const origin = c.req.header("origin");
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
        { status: worker.status },
      ),
      CORS_METHODS,
      origin,
    );
  }
  const r = await resolveSharedAgent(c, {
    cacheOnly: true,
    executionCtx: worker.executionCtx,
  });
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: r.error,
          ...(r.code ? { code: r.code } : {}),
          ...(r.status === 503 ? { retryable: true } : {}),
        },
        {
          status: r.status,
          ...(r.retryAfterSeconds
            ? { headers: { "Retry-After": String(r.retryAfterSeconds) } }
            : {}),
        },
      ),
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
  let result: { text: string; agentName: string };
  try {
    result = await sharedRestMessageSend(
      r.agent,
      conversationId,
      text,
      r.agentName,
      worker.executionCtx,
      worker.namespace,
      sharedTurnClientMessageId(raw),
      "agentKind" in r ? "platform" : "organization-credits",
      undefined,
      text,
    );
  } catch (error) {
    // error-policy:J1 route boundary translates bridge/billing failures to HTTP responses.
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
        origin,
      );
    }
    if (error instanceof RateLimitError) {
      return applyCorsHeaders(
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
        origin,
      );
    }
    // A reused clientMessageId with different text must not replace the landed
    // turn — non-retryable by contract; the caller picks a new id (#18045).
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
        origin,
      );
    }
    // Insufficient credits is a PERMANENT condition until the org tops up —
    // hiding it behind the generic retryable 503 below reads as "try again"
    // forever to every welcome-bonus-withheld signup and drained org. Return
    // the canonical 402 the agent-create path uses so the app can route to
    // add-credits instead. The message is our own billing copy (required vs
    // available), safe to show.
    if (error instanceof InsufficientCreditsError) {
      logger.warn(
        "[shared-runtime REST] message.send rejected: insufficient credits",
        {
          agentId: r.agentId,
        },
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
    // A shared-bridge / inference failure (transient: cold sandbox, provider
    // 429/5xx, timeout) would otherwise surface as a bare 500 on the
    // launch-critical first chat turn. Return a structured, retryable error so
    // the app can show a "try again" affordance instead of a hard failure. The
    // message is sanitized (no internal/provider details leak to the client).
    logger.warn("[shared-runtime REST] message.send failed", {
      agentId: r.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: "The agent is temporarily unavailable. Please try again.",
          code: "inference_unavailable",
          retryable: true,
        },
        { status: 503 },
      ),
      CORS_METHODS,
      origin,
    );
  }
  return applyCorsHeaders(Response.json(result), CORS_METHODS, origin);
});

export default app;
