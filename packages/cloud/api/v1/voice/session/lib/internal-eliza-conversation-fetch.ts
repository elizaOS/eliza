/**
 * Routes authenticated realtime voice turns through cache-authorized shared
 * runtime Durable Objects after the WebSocket upgrade request has returned.
 *
 * The response-facing module never imports a repository. A cache miss registers
 * the authoritative scope hydrator with waitUntil and returns a retryable 503;
 * warm turns pass the cached agent into the canonical handler so its type-level
 * contract cannot select the legacy database-backed bridge.
 */

import type { AgentSandbox } from "@/db/repositories/agent-sandboxes";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import { cache } from "@/lib/cache/client";
import { CacheKeys } from "@/lib/cache/keys";
import {
  hasCloudBindingsContext,
  runWithCloudBindingsAsync,
} from "@/lib/runtime/cloud-bindings";
import { handleCanonicalScopedAgentStream } from "@/lib/services/shared-runtime/canonical-scoped-stream";
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
};

export type InternalElizaConversationFetchFactory = (
  claims: InternalElizaConversationFetchClaims,
) => InternalElizaConversationFetch;

interface InternalVoiceSharedRuntime {
  executionCtx?: BridgeExecutionContext;
  namespace?: RuntimeDurableObjectNamespace;
  readCachedAgent(): Promise<AgentSandbox | null>;
  scheduleHydration(): boolean;
}

function isCachedVoiceAgent(
  agent: AgentSandbox | null,
  claims: InternalElizaConversationFetchClaims,
): agent is AgentSandbox {
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

    const readCachedAgent = async (): Promise<AgentSandbox | null> => {
      const cached = await cache.get<AgentSandbox>(cacheKey);
      return isCachedVoiceAgent(cached, claims) ? cached : null;
    };

    const scheduleHydration = (): boolean => {
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
      if (!env.SHARED_RUNTIME_CONVERSATIONS || !executionCtx) return;
      await runWithCloudBindingsAsync(
        env as unknown as Record<string, unknown>,
        async () => {
          if (!(await readCachedAgent())) scheduleHydration();
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
  assertCanonicalVoiceStreamPath(url, claims);
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
    abortSignal: request.signal,
    agent,
    agentId: claims.agentId,
    orgId: claims.organizationId,
    conversationId: claims.conversationId,
    userId: claims.userId,
    body,
    origin: headers.get("origin"),
    namespace: runtime.namespace,
    executionCtx: runtime.executionCtx,
  });
}

function assertCanonicalVoiceStreamPath(
  url: URL,
  claims: InternalElizaConversationFetchClaims,
): void {
  const match = url.pathname.match(
    /^\/api\/v1\/eliza\/agents\/([^/]+)\/api\/conversations\/([^/]+)\/messages\/stream$/,
  );
  if (!match) {
    throw new TypeError(
      `unsupported internal Eliza stream path: ${url.pathname}`,
    );
  }
  const agentId = decodeURIComponent(match[1]);
  const conversationId = decodeURIComponent(match[2]);
  if (agentId !== claims.agentId || conversationId !== claims.conversationId) {
    throw new TypeError(
      "internal Eliza stream path does not match session scope",
    );
  }
}
