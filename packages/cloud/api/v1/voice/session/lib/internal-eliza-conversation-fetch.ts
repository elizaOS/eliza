/**
 * Routes authenticated realtime voice turns through cache-authorized shared
 * runtime Durable Objects after the WebSocket upgrade request has returned.
 *
 * The response-facing module never imports a repository. A cache miss registers
 * the authoritative scope hydrator with waitUntil and returns a retryable 503;
 * warm turns pass the cached agent into the canonical handler so its type-level
 * contract cannot select the legacy database-backed bridge.
 */

import { ChannelType, MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core/edge";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import { cache } from "@/lib/cache/client";
import { CacheKeys } from "@/lib/cache/keys";
import { resolveElizaTraceId } from "@/lib/observability/http-telemetry";
import {
  hasCloudBindingsContext,
  runWithCloudBindingsAsync,
} from "@/lib/runtime/cloud-bindings";
import { handleCanonicalScopedAgentStream } from "@/lib/services/shared-runtime/canonical-scoped-stream";
import {
  coordinateSharedConversationPrewarm,
  coordinateSharedLifecycleEvent,
  type SharedConversationLifecycleEvent,
} from "@/lib/services/shared-runtime/conversation-coordinator";
import {
  isPersonalSharedAgentId,
  personalSharedAgent,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import type { SharedRuntimeAgent } from "@/lib/services/shared-runtime/shared-runtime-agent";
import type { BridgeExecutionContext } from "@/lib/services/shared-runtime/shared-runtime-chat";
import { logger } from "@/lib/utils/logger";
import type {
  Bindings,
  RuntimeDurableObjectNamespace,
} from "@/types/cloud-worker-env";

export interface InternalElizaConversationFetchClaims {
  agentId: string;
  conversationId: string;
  organizationId: string;
  userId: string;
}

export type InternalElizaConversationFetch = typeof fetch & {
  /** Read the immutable tenancy cache and schedule cold hydration before first turn. */
  prewarm: () => Promise<void>;
  /** Persist an idempotent call lifecycle marker in the canonical room. */
  recordLifecycleEvent: (
    event: SharedConversationLifecycleEvent,
  ) => Promise<void>;
};

export type InternalElizaConversationFetchFactory = (
  claims: InternalElizaConversationFetchClaims,
) => InternalElizaConversationFetch;

interface InternalVoiceSharedRuntime {
  executionCtx?: BridgeExecutionContext;
  namespace?: RuntimeDurableObjectNamespace;
  readCachedAgent(): Promise<SharedRuntimeAgent | null>;
  scheduleHydration(): boolean;
}

function isCachedVoiceAgent(
  agent: SharedRuntimeAgent | null,
  claims: InternalElizaConversationFetchClaims,
): agent is SharedRuntimeAgent {
  return Boolean(
    agent &&
      agent.id === claims.agentId &&
      agent.organization_id === claims.organizationId &&
      agent.user_id === claims.userId &&
      agent.execution_tier === "shared",
  );
}

function unavailableResponse(
  code: "agent_cache_warming" | "shared_runtime_unavailable",
  error: string,
): Response {
  return Response.json(
    {
      success: false,
      error,
      code,
      retryable: true,
    },
    { status: 503 },
  );
}

/**
 * Capture durable Worker bindings and the execution context while the upgrade
 * request is live. Late WebSocket events restore the bindings for cache access;
 * only a registered background hydration task creates a fresh DB context.
 */
export function createInternalElizaConversationFetchFactory(
  env: Bindings,
  executionCtx?: BridgeExecutionContext,
): InternalElizaConversationFetchFactory {
  logger.info("[voice-sse-context] route construction", {
    cloudBindingsContext: hasCloudBindingsContext(),
    conversationCoordinator: Boolean(env.SHARED_RUNTIME_CONVERSATIONS),
    executionContext: Boolean(executionCtx),
  });

  return (claims) => {
    const cacheKey = CacheKeys.sharedAgentScope.voice(
      claims.organizationId,
      claims.userId,
      claims.agentId,
    );
    let hydrationPromise: Promise<void> | null = null;

    const personalAgent = isPersonalSharedAgentId(claims.agentId)
      ? personalSharedAgent({
          userId: claims.userId,
          organizationId: claims.organizationId,
        })
      : null;
    const readCachedAgent = async (): Promise<SharedRuntimeAgent | null> => {
      if (personalAgent?.id === claims.agentId) return personalAgent;
      const cached = await cache.get<SharedRuntimeAgent>(cacheKey);
      return isCachedVoiceAgent(cached, claims) ? cached : null;
    };

    const scheduleHydration = (): boolean => {
      if (personalAgent) return true;
      if (!executionCtx) return false;
      if (hydrationPromise) return true;

      const hydration = Promise.resolve()
        .then(() => import("./voice-agent-scope-hydration"))
        .then(({ hydrateVoiceSharedAgentScope }) =>
          hydrateVoiceSharedAgentScope(env, claims),
        )
        .catch((error) => {
          // error-policy:J7 the cache miss remains an explicit retryable 503;
          // diagnostics record why the background fill did not make progress.
          logger.warn("[voice-sse-context] background scope hydration failed", {
            agentId: claims.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (hydrationPromise === hydration) hydrationPromise = null;
        });
      hydrationPromise = hydration;
      executionCtx.waitUntil(hydration);
      return true;
    };

    const prewarm = async (): Promise<void> => {
      const namespace = env.SHARED_RUNTIME_CONVERSATIONS;
      if (!namespace || !executionCtx) return;
      await runWithCloudBindingsAsync(
        env as unknown as Record<string, unknown>,
        async () => {
          let agent = await readCachedAgent();
          let conversationPrewarmAttemptedByHydration = false;
          if (!agent) {
            scheduleHydration();
            // Capture before awaiting: the hydration's finally block clears the
            // shared slot. Joining this exact promise lets the first voice turn
            // use the freshly cached scope without cache-miss polling/backoff.
            const pendingHydration = hydrationPromise;
            if (pendingHydration) {
              await pendingHydration;
              conversationPrewarmAttemptedByHydration = true;
            }
            agent = await readCachedAgent();
          }
          if (!agent || conversationPrewarmAttemptedByHydration) return;
          await coordinateSharedConversationPrewarm(
            agent.id,
            claims.conversationId,
            { namespace },
          );
        },
      );
    };

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      logger.info("[voice-sse-context] adapter entry", {
        cloudBindingsContext: hasCloudBindingsContext(),
      });

      return runWithCloudBindingsAsync(
        env as unknown as Record<string, unknown>,
        async () => {
          try {
            const response = await dispatchInternalElizaConversationFetch(
              env,
              claims,
              input,
              init,
              {
                executionCtx,
                namespace: env.SHARED_RUNTIME_CONVERSATIONS,
                readCachedAgent,
                scheduleHydration,
              },
            );
            logger.info("[voice-sse-context] before response", {
              cloudBindingsContext: hasCloudBindingsContext(),
              status: response.status,
            });
            return response;
          } catch (error) {
            // error-policy:J2 preserve the original failure after recording
            // bounded context-lifetime diagnostics at the adapter boundary.
            logger.error("[voice-sse-context] adapter failed before response", {
              errorClass: error instanceof Error ? error.name : typeof error,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      );
    }) as InternalElizaConversationFetch;
    fetchImpl.prewarm = prewarm;
    fetchImpl.recordLifecycleEvent = async (event) => {
      const namespace = env.SHARED_RUNTIME_CONVERSATIONS;
      if (!namespace) {
        throw new Error(
          "Shared runtime conversation coordinator is unavailable.",
        );
      }
      await runWithCloudBindingsAsync(
        env as unknown as Record<string, unknown>,
        () =>
          coordinateSharedLifecycleEvent(
            claims.agentId,
            claims.conversationId,
            event,
            { namespace },
          ),
      );
    };
    return fetchImpl;
  };
}

/** Compatibility helper for direct/test callers. */
export function createInternalElizaConversationFetch(
  env: Bindings,
  claims: InternalElizaConversationFetchClaims,
  executionCtx?: BridgeExecutionContext,
): InternalElizaConversationFetch {
  return createInternalElizaConversationFetchFactory(env, executionCtx)(claims);
}

async function dispatchInternalElizaConversationFetch(
  env: Bindings,
  claims: InternalElizaConversationFetchClaims,
  input: RequestInfo | URL,
  init?: RequestInit,
  runtime?: InternalVoiceSharedRuntime,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const pathValidation = validateCanonicalVoiceStreamPath(url, claims);
  if (!pathValidation.ok) {
    if (pathValidation.kind === "malformed") {
      return Response.json(
        {
          success: false,
          error: "invalid conversation path: malformed URL encoding",
        },
        { status: 400 },
      );
    }
    throw new TypeError(pathValidation.message);
  }
  if (request.method !== "POST") {
    return Response.json(
      { success: false, error: "Method not allowed" },
      { status: 405 },
    );
  }
  const headers = request.headers;
  const configured = env.VOICE_REALTIME_ELIZA_AUTHORIZATION;
  const presented = headers.get("authorization");
  if (
    !configured ||
    !presented ||
    !timingSafeEqualSecret(presented, configured)
  ) {
    return Response.json(
      { success: false, error: "Agent not found", code: "agent_not_found" },
      { status: 404 },
    );
  }
  if (
    headers.get("X-Eliza-Agent-Id") !== claims.agentId ||
    headers.get("X-Eliza-Conversation-Id") !== claims.conversationId ||
    headers.get("X-Eliza-Organization-Id") !== claims.organizationId ||
    headers.get("X-Eliza-User-Id") !== claims.userId
  ) {
    return Response.json(
      { success: false, error: "Agent not found", code: "agent_not_found" },
      { status: 404 },
    );
  }

  if (!runtime?.namespace || !runtime.executionCtx) {
    return unavailableResponse(
      "shared_runtime_unavailable",
      "Shared runtime conversation coordinator is unavailable.",
    );
  }

  const agent = await runtime.readCachedAgent();
  if (!agent) {
    const scheduled = runtime.scheduleHydration();
    return unavailableResponse(
      scheduled ? "agent_cache_warming" : "shared_runtime_unavailable",
      scheduled
        ? "Agent authorization cache is warming. Retry shortly."
        : "Agent authorization cache is unavailable.",
    );
  }

  const rawText = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    // error-policy:J3 untrusted-input sanitizing. Match the public route.
    body = {};
  }

  return handleCanonicalScopedAgentStream({
    traceId: resolveElizaTraceId(headers),
    abortSignal: request.signal,
    agent,
    agentId: claims.agentId,
    orgId: claims.organizationId,
    conversationId: claims.conversationId,
    userId: claims.userId,
    agentKind: isPersonalSharedAgentId(claims.agentId) ? "personal" : "sandbox",
    trustedMessageRole:
      body &&
      typeof body === "object" &&
      (body as { messageRole?: unknown }).messageRole === "system"
        ? "system"
        : undefined,
    channel: {
      type: ChannelType.VOICE_DM,
      source: MESSAGE_SOURCE_CLIENT_CHAT,
    },
    body,
    origin: headers.get("origin"),
    namespace: runtime.namespace,
    executionCtx: runtime.executionCtx,
  });
}

function decodeStreamPathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    // error-policy:J3 Internal route segments are untrusted input. A null
    // result is translated into the explicit malformed-path response below.
    return null;
  }
}

type VoiceStreamPathValidation =
  | { ok: true }
  | {
      ok: false;
      kind: "unsupported" | "malformed" | "scope_mismatch";
      message: string;
    };

function validateCanonicalVoiceStreamPath(
  url: URL,
  claims: InternalElizaConversationFetchClaims,
): VoiceStreamPathValidation {
  const match = url.pathname.match(
    /^\/api\/v1\/eliza\/agents\/([^/]+)\/api\/conversations\/([^/]+)\/messages\/stream$/,
  );
  if (!match) {
    return {
      ok: false,
      kind: "unsupported",
      message: `unsupported internal Eliza stream path: ${url.pathname}`,
    };
  }
  const agentId = decodeStreamPathSegment(match[1]);
  const conversationId = decodeStreamPathSegment(match[2]);
  if (agentId === null || conversationId === null) {
    return {
      ok: false,
      kind: "malformed",
      message: "invalid internal Eliza stream path: malformed URL encoding",
    };
  }
  if (agentId !== claims.agentId || conversationId !== claims.conversationId) {
    return {
      ok: false,
      kind: "scope_mismatch",
      message: "internal Eliza stream path does not match session scope",
    };
  }
  return { ok: true };
}
