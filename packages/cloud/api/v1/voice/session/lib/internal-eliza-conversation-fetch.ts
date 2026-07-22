/**
 * Keeps realtime voice turns inside a fresh Worker bindings/DB context even
 * though the WebSocket message arrives after the upgrade request has returned.
 */

import { hasDbCacheContext, runWithDbCacheAsync } from "@/db/client";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import {
  hasCloudBindingsContext,
  runWithCloudBindingsAsync,
} from "@/lib/runtime/cloud-bindings";
import { handleCanonicalScopedAgentStream } from "@/lib/services/shared-runtime/canonical-scoped-stream";
import { logger } from "@/lib/utils/logger";
import type { Bindings } from "@/types/cloud-worker-env";

export interface InternalElizaConversationFetchClaims {
  agentId: string;
  conversationId: string;
  organizationId: string;
  userId: string;
}

export type InternalElizaConversationFetch = typeof fetch & {
  /** Warm and cache the immutable voice-token tenancy lookup before first turn. */
  prewarm: () => Promise<void>;
};

export type InternalElizaConversationFetchFactory = (
  claims: InternalElizaConversationFetchClaims,
) => InternalElizaConversationFetch;

/**
 * Capture durable Worker bindings while the upgrade request is live. Each late
 * WebSocket turn restores those bindings plus a fresh per-turn DB cache before
 * repository/service access. A DB cache from the upgrade request must not be
 * reused because Workers prohibit I/O across request/event lifetimes.
 */
export function createInternalElizaConversationFetchFactory(
  env: Bindings,
): InternalElizaConversationFetchFactory {
  logger.info("[voice-sse-context] route construction", {
    cloudBindingsContext: hasCloudBindingsContext(),
    dbCacheContext: hasDbCacheContext(),
  });

  return (claims) => {
    let scopePreverified = false;
    let prewarmPromise: Promise<void> | null = null;

    const prewarm = (): Promise<void> => {
      if (scopePreverified) return Promise.resolve();
      if (prewarmPromise) return prewarmPromise;
      prewarmPromise = runWithCloudBindingsAsync(
        env as unknown as Record<string, unknown>,
        () =>
          runWithDbCacheAsync(async () => {
            const agent = await agentSandboxesRepository.findByIdAndOrg(
              claims.agentId,
              claims.organizationId,
            );
            scopePreverified = Boolean(
              agent && agent.user_id === claims.userId,
            );
          }),
      ).finally(() => {
        prewarmPromise = null;
      });
      return prewarmPromise;
    };

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      logger.info("[voice-sse-context] adapter entry", {
        cloudBindingsContext: hasCloudBindingsContext(),
        dbCacheContext: hasDbCacheContext(),
      });

      // If session-start warming is still in flight, reuse its result rather
      // than issuing the same tenancy query concurrently on the first turn.
      // Warmup is best-effort: a transient failure must fall through to the
      // normal per-turn validation, never fail the user's turn by itself.
      if (prewarmPromise) await prewarmPromise.catch(() => undefined);

      return runWithCloudBindingsAsync(
        env as unknown as Record<string, unknown>,
        () =>
          runWithDbCacheAsync(async () => {
            try {
              const response = await dispatchInternalElizaConversationFetch(
                env,
                claims,
                input,
                init,
                scopePreverified,
              );
              logger.info("[voice-sse-context] before response", {
                cloudBindingsContext: hasCloudBindingsContext(),
                dbCacheContext: hasDbCacheContext(),
                status: response.status,
              });
              return response;
            } catch (error) {
              // error-policy:J2 preserve the original failure after recording
              // bounded context-lifetime diagnostics at the adapter boundary.
              logger.error(
                "[voice-sse-context] adapter failed before response",
                {
                  errorClass:
                    error instanceof Error ? error.name : typeof error,
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                },
              );
              throw error;
            }
          }),
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
): typeof fetch {
  return createInternalElizaConversationFetchFactory(env)(claims);
}

async function dispatchInternalElizaConversationFetch(
  env: Bindings,
  claims: InternalElizaConversationFetchClaims,
  input: RequestInfo | URL,
  init?: RequestInit,
  scopePreverified = false,
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

  if (!scopePreverified) {
    const agent = await agentSandboxesRepository.findByIdAndOrg(
      claims.agentId,
      claims.organizationId,
    );
    if (!agent || agent.user_id !== claims.userId) {
      return Response.json(
        { success: false, error: "Agent not found", code: "agent_not_found" },
        { status: 404 },
      );
    }
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
    agentId: claims.agentId,
    orgId: claims.organizationId,
    conversationId: claims.conversationId,
    userId: claims.userId,
    body,
    origin: headers.get("origin"),
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
