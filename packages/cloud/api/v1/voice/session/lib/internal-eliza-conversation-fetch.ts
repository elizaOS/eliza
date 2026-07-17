/**
 * In-process fetch adapter for realtime voice turns that target the canonical
 * Eliza conversation SSE route. The voice bridge keeps its HTTP-shaped contract
 * for tests and future transports, but Worker production dispatches the scoped
 * request directly into the canonical stream core so nested Hono dispatch cannot
 * turn a valid voice request into a same-worker adapter failure.
 */
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import { handleCanonicalScopedAgentStream } from "@/lib/services/shared-runtime/canonical-scoped-stream";
import type { Bindings } from "@/types/cloud-worker-env";

export interface InternalElizaConversationFetchClaims {
  agentId: string;
  conversationId: string;
  organizationId: string;
  userId: string;
}

export function createInternalElizaConversationFetch(
  env: Bindings,
  claims: InternalElizaConversationFetchClaims,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
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
      headers.get("X-Eliza-Organization-Id") !== claims.organizationId ||
      headers.get("X-Eliza-User-Id") !== claims.userId
    ) {
      return Response.json(
        { success: false, error: "Agent not found", code: "agent_not_found" },
        { status: 404 },
      );
    }

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

    const rawText = await request.text();
    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      // error-policy:J3 untrusted-input sanitizing — malformed JSON becomes the
      // same explicit validation response as the public HTTP route's parsed body.
      body = {};
    }

    return handleCanonicalScopedAgentStream({
      agentId: claims.agentId,
      orgId: claims.organizationId,
      conversationId: claims.conversationId,
      body,
      origin: headers.get("origin"),
    });
  }) as typeof fetch;
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
