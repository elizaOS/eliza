/**
 * Account-scoped Shared chat for the personal Eliza service.
 *
 * This route authenticates the account, derives its rowless Eliza identity,
 * and addresses the existing conversation Durable Object. It never creates or
 * resolves an agent_sandboxes row and never admits a user-funded inference.
 */

import { Hono } from "hono";
import { z } from "zod";
import { RateLimitError } from "@/lib/api/errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import { resolveSharedRuntimeWorkerRequestContext } from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestMessageSend,
  sharedRestMessagesGet,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import { sharedTurnClientMessageId } from "@/lib/services/shared-runtime/shared-runtime-chat";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, POST, OPTIONS";
const messageSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  clientMessageId: z.string().trim().min(1).max(128).optional(),
});

function identityDto(agent: ReturnType<typeof personalSharedAgent>) {
  return {
    id: agent.id,
    displayName: agent.agent_name ?? "Eliza",
    runtime: "shared" as const,
  };
}

function unavailableResponse(error: unknown, origin?: string): Response {
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
          headers: { "Retry-After": String(error.retryAfter ?? 60) },
        },
      ),
      CORS_METHODS,
      origin,
    );
  }
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
  const warming =
    error instanceof Error && error.name === "SharedRuntimeCacheWarmingError";
  return applyCorsHeaders(
    Response.json(
      {
        success: false,
        error: warming
          ? error.message
          : "Shared chat is temporarily unavailable. Please try again.",
        code: warming
          ? "shared_runtime_cache_warming"
          : "inference_unavailable",
        retryable: true,
      },
      {
        status: 503,
        ...(warming ? { headers: { "Retry-After": "1" } } : {}),
      },
    ),
    CORS_METHODS,
    origin,
  );
}

const app = new Hono<AppEnv>();

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

app.get("/", async (c) => {
  const origin = c.req.header("origin");
  const user = await requireUserOrApiKeyWithOrg(c);
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
      origin,
    );
  }

  const agent = personalSharedAgent({
    userId: user.id,
    organizationId: user.organization_id,
  });
  try {
    const { messages } = await sharedRestMessagesGet(
      agent.id,
      agent.id,
      worker.namespace,
    );
    return applyCorsHeaders(
      Response.json({
        success: true,
        data: { identity: identityDto(agent), messages },
      }),
      CORS_METHODS,
      origin,
    );
  } catch (error) {
    logger.warn("[personal-shared] history read failed", {
      personalElizaId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return unavailableResponse(error, origin);
  }
});

app.post("/", async (c) => {
  const origin = c.req.header("origin");
  const user = await requireUserOrApiKeyWithOrg(c);
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
      origin,
    );
  }

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: "A non-empty message of at most 4000 characters is required.",
          code: "invalid_message",
          retryable: false,
        },
        { status: 400 },
      ),
      CORS_METHODS,
      origin,
    );
  }

  const agent = personalSharedAgent({
    userId: user.id,
    organizationId: user.organization_id,
  });
  try {
    const reply = await sharedRestMessageSend(
      agent,
      agent.id,
      parsed.data.text,
      agent.agent_name ?? "Eliza",
      worker.executionCtx,
      worker.namespace,
      sharedTurnClientMessageId(raw),
      "platform",
    );
    return applyCorsHeaders(
      Response.json({
        success: true,
        data: { identity: identityDto(agent), reply },
      }),
      CORS_METHODS,
      origin,
    );
  } catch (error) {
    logger.warn("[personal-shared] message send failed", {
      personalElizaId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return unavailableResponse(error, origin);
  }
});

export default app;
