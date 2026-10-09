// Handles v1 cloud API v1 eliza agents agentid api conversations route traffic with route-local auth expectations.

import {
  personalDirectChatRefusalResponse,
  resolveSharedSurfaceTarget,
} from "@elizaos/cloud-shared/lib/services/personal-direct-chat-route";
import {
  applyCorsHeaders,
  handleCorsOptions,
} from "@elizaos/cloud-shared/lib/services/proxy/cors";
import { prewarmResolvedSharedAgentSession } from "@elizaos/cloud-shared/lib/services/shared-runtime/prewarm-shared-agent";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@elizaos/cloud-shared/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestConversationCreate,
  sharedRestConversationsList,
} from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Context } from "hono";
import { Hono } from "hono";
import { proxyLocalDedicatedOrNext } from "../_local-dedicated-proxy";

/**
 * /api/v1/eliza/agents/[agentId]/api/conversations
 *
 * The REST conversation surface for a SHARED-runtime agent (which has no agent
 * server of its own). Launch model: ONE canonical conversation per agent
 * (id === agentId), so the list is always one item and create is idempotent.
 * Scoped to shared-tier agents owned by the caller's org; dedicated agents use
 * their own subdomain REST surface, not this adapter.
 */
const CORS_METHODS = "GET, POST, OPTIONS";

const app = new Hono<AppEnv>();

/**
 * The personal identity lists its conversation only while Shared owns it
 * (#25146): Dedicated ownership is a typed 409 with the Dedicated agent id,
 * and a withdrawn Dedicated keeps the canonical id, which the message
 * surfaces serve from the scoped fallback journal.
 */
async function personalConversationRefusal(
  c: Context<AppEnv>,
  r: Extract<
    Awaited<ReturnType<typeof resolveSharedAgent>>,
    { agentId: string }
  >,
): Promise<Response | null> {
  if (!("agentKind" in r)) return null;
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
    );
  }
  const target = await resolveSharedSurfaceTarget({
    agent: r.agent,
    personal: true,
    conversationId: r.agentId,
    namespace: worker.namespace,
  });
  if (target.ok) return null;
  const refusal = personalDirectChatRefusalResponse(target.refusal);
  return applyCorsHeaders(
    Response.json(refusal.body, {
      status: refusal.status,
      headers: refusal.headers,
    }),
    CORS_METHODS,
  );
}

app.use("*", proxyLocalDedicatedOrNext);

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
    );
  }
  const refused = await personalConversationRefusal(c, r);
  if (refused) return refused;
  // Opening the conversation is the session start: warm every cache the
  // cache-only first turn consults before a human can type, so that turn does
  // not pay the retryable warming 503 (#22552). Off the response path; a
  // missing Worker context only skips the warm.
  const worker = resolveSharedRuntimeWorkerRequestContext(c);
  if (!("error" in worker)) {
    worker.executionCtx.waitUntil(
      prewarmResolvedSharedAgentSession(r, {
        namespace: worker.namespace,
        requestContext: c,
      }),
    );
  }
  const body = sharedRestConversationsList(
    r.agentId,
    r.agent.agent_name ?? "Eliza",
    ("createdAt" in r ? r.createdAt : r.agent.created_at).toISOString(),
  );
  return applyCorsHeaders(Response.json(body), CORS_METHODS);
});

app.post("/", async (c) => {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
    );
  }
  const refused = await personalConversationRefusal(c, r);
  if (refused) return refused;
  const body = sharedRestConversationCreate(
    r.agentId,
    r.agent.agent_name ?? "Eliza",
    ("createdAt" in r ? r.createdAt : r.agent.created_at).toISOString(),
  );
  return applyCorsHeaders(Response.json(body), CORS_METHODS);
});

export default app;
