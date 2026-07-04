// Handles v1 cloud API v1 eliza agents agentid api conversations route traffic with route-local auth expectations.
import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestConversationCreate,
  sharedRestConversationsList,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";

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

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
    );
  }
  const body = sharedRestConversationsList(
    r.agentId,
    r.agent.agent_name ?? "Eliza",
    r.agent.created_at.toISOString(),
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
    r.agent.created_at.toISOString(),
  );
  return applyCorsHeaders(Response.json(body), CORS_METHODS);
});

export default app;
