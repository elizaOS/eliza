// Handles v1 cloud API v1 eliza agents agentid api conversations route traffic with route-local auth expectations.
import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { prewarmResolvedSharedAgentSession } from "@/lib/services/shared-runtime/prewarm-shared-agent";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestConversationCreate,
  sharedRestConversationsList,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";
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
  const body = sharedRestConversationCreate(
    r.agentId,
    r.agent.agent_name ?? "Eliza",
    ("createdAt" in r ? r.createdAt : r.agent.created_at).toISOString(),
  );
  return applyCorsHeaders(Response.json(body), CORS_METHODS);
});

export default app;
