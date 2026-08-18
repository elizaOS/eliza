/**
 * Serves shared-agent conversation turns as Cloudflare-native SSE.
 *
 * Scope authorization and turn execution are cache-only on the response path;
 * cold hydration is scheduled under waitUntil and surfaced as retryable 503.
 */
import { ChannelType, MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core/edge";
import { Hono } from "hono";
import type { AgentSandbox } from "@/db/repositories/agent-sandboxes";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  type CachedAgentSandbox,
  rehydrateCachedAgentDates,
} from "@/lib/services/shared-runtime/cached-agent-dates";
import {
  type CanonicalScopedStreamRequest,
  handleCanonicalScopedAgentStream,
} from "@/lib/services/shared-runtime/canonical-scoped-stream";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { BridgeExecutionContext } from "@/lib/services/shared-runtime/shared-runtime-chat";
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
 * through the conversation Durable Object and emit its reply as SSE. The object
 * owns warm history and cache-only turn execution; cold authoritative hydration
 * is registered with waitUntil and reported as a retryable 503.
 *
 * The route returns the conversation coordinator's response body without
 * reading it, preserving incremental flushes from the Durable Object to the
 * Cloudflare edge.
 * Shared-tier + org-scoped (resolveSharedAgent gates auth, org-scope, tier).
 */
const CORS_METHODS = "POST, OPTIONS";
const VOICE_AGENT_HEADER = "X-Eliza-Agent-Id";
const VOICE_CONVERSATION_HEADER = "X-Eliza-Conversation-Id";
const VOICE_ORGANIZATION_HEADER = "X-Eliza-Organization-Id";
const VOICE_USER_HEADER = "X-Eliza-User-Id";

const app = new Hono<AppEnv>();

function nowMs(): number {
  return performance.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

async function resolveAgentScope(
  c: Parameters<typeof resolveSharedAgent>[0],
  executionCtx: BridgeExecutionContext,
) {
  const configured = c.env?.VOICE_REALTIME_ELIZA_AUTHORIZATION;
  const presented = c.req.header("authorization");
  if (configured && presented && timingSafeEqualSecret(presented, configured)) {
    const agentId = c.req.param("agentId") ?? "";
    const conversationId = c.req.param("conversationId") ?? "";
    const scopedAgentId = c.req.header(VOICE_AGENT_HEADER) ?? "";
    const scopedConversationId = c.req.header(VOICE_CONVERSATION_HEADER) ?? "";
    const orgId = c.req.header(VOICE_ORGANIZATION_HEADER) ?? "";
    const userId = c.req.header(VOICE_USER_HEADER) ?? "";
    if (
      !agentId ||
      !conversationId ||
      scopedAgentId !== agentId ||
      scopedConversationId !== conversationId ||
      !orgId ||
      !userId
    ) {
      return {
        error: "Agent not found",
        code: "agent_not_found",
        status: 404 as const,
      };
    }
    const cacheKey = CacheKeys.sharedAgentScope.voice(orgId, userId, agentId);
    // The voice scope cache stores either the serialized agent row or a
    // negative sentinel. Recording the negative outcome is what lets the
    // cache-only warming state converge: an entry that can never be written
    // (mismatched user, dedicated tier, not found) would otherwise loop the
    // retryable 503 forever. This route serves the SHARED tier only, so a
    // known-negative is a definitive 404.
    let cachedScope: CachedAgentSandbox | { unresolvable: true } | null;
    try {
      cachedScope = await cache.get<
        CachedAgentSandbox | { unresolvable: true }
      >(cacheKey);
    } catch {
      // error-policy:J4 a cache dependency failure remains distinguishable
      // from a missing agent and never falls through to Postgres inline.
      return {
        error: "Agent authorization cache is unavailable. Retry shortly.",
        code: "agent_cache_unavailable",
        status: 503 as const,
      };
    }
    const knownNegative =
      cachedScope != null &&
      (cachedScope as { unresolvable?: boolean }).unresolvable === true;
    if (knownNegative) {
      return {
        error: "Agent not found",
        code: "agent_not_found",
        status: 404 as const,
      };
    }
    const agent: AgentSandbox | null = cachedScope
      ? // Restore the Date contract lost to the cache's JSON round-trip before
        // any consumer reads a timestamp column.
        rehydrateCachedAgentDates(cachedScope as CachedAgentSandbox)
      : null;
    if (!agent) {
      const hydration = import(
        "@/api/v1/voice/session/lib/voice-agent-scope-hydration"
      )
        .then(async ({ hydrateVoiceSharedAgentScope }) => {
          await hydrateVoiceSharedAgentScope(c.env, {
            agentId,
            conversationId,
            organizationId: orgId,
            userId,
          });
          const hydrated = await cache.get<
            CachedAgentSandbox | { unresolvable: true }
          >(cacheKey);
          if (!hydrated) {
            await cache.set(
              cacheKey,
              { unresolvable: true },
              CacheTTL.sharedAgentScope.resolve,
            );
          }
        })
        .catch((error) => {
          // error-policy:J7 the request remains a retryable cache miss while
          // diagnostics record why its authoritative background fill failed.
          logger.warn("[shared-runtime REST] voice scope hydration failed", {
            agentId,
            conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      executionCtx.waitUntil(hydration);
      return {
        error: "Agent authorization cache is warming. Retry shortly.",
        code: "agent_cache_warming",
        status: 503 as const,
        retryAfterSeconds: 1,
      };
    }
    if (
      agent.id !== agentId ||
      agent.organization_id !== orgId ||
      agent.user_id !== userId ||
      agent.execution_tier !== "shared"
    ) {
      return {
        error: "Agent not found",
        code: "agent_not_found",
        status: 404 as const,
      };
    }
    return {
      agent,
      agentId: agent.id,
      orgId,
      userId,
      agentName: agent.agent_name ?? "Agent",
      agentKind: "sandbox" as const,
    };
  }
  return resolveSharedAgent(c, {
    cacheOnly: true,
    executionCtx,
  });
}

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

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
  const scopeStartedAt = nowMs();
  const scopePromise = resolveAgentScope(c, worker.executionCtx).then(
    (result) => ({
      result,
      durationMs: elapsedMs(scopeStartedAt),
    }),
  );
  const bodyStartedAt = nowMs();
  const bodyPromise = c.req
    .json()
    .catch(() => {
      // error-policy:J3 untrusted-input sanitizing. Match the canonical stream
      // contract: malformed JSON is an invalid request body, not a fabricated
      // successful turn.
      return {};
    })
    .then((body: unknown) => ({
      body,
      durationMs: elapsedMs(bodyStartedAt),
    }));

  const [
    { result: r, durationMs: scopeMs },
    { body: raw, durationMs: bodyMs },
  ] = await Promise.all([scopePromise, bodyPromise]);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: r.error,
          ...("code" in r ? { code: r.code } : {}),
          ...(r.status === 503 ? { retryable: true } : {}),
        },
        {
          status: r.status,
          ...("retryAfterSeconds" in r && r.retryAfterSeconds
            ? { headers: { "Retry-After": String(r.retryAfterSeconds) } }
            : {}),
        },
      ),
      CORS_METHODS,
      origin,
    );
  }

  const conversationId = c.req.param("conversationId") ?? r.agentId;
  return handleCanonicalScopedAgentStream({
    abortSignal: c.req.raw.signal,
    agent: r.agent,
    agentId: r.agentId,
    orgId: r.orgId,
    conversationId,
    ...("userId" in r ? { userId: r.userId } : {}),
    body: raw,
    origin,
    namespace: worker.namespace,
    agentKind: "agentKind" in r ? r.agentKind : "sandbox",
    trustedChannel: {
      source: MESSAGE_SOURCE_CLIENT_CHAT,
      channelType: ChannelType.DM,
    },
    // The Worker context carries both cold hydration and the shared turn's
    // deferred billing tail without putting either on the response path.
    executionCtx: worker.executionCtx,
    timings: {
      scope: scopeMs,
      body: bodyMs,
    },
  } satisfies CanonicalScopedStreamRequest);
});

export default app;
