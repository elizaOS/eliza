import { type Context, Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
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

async function resolveSharedAgent(c: Context<AppEnv>) {
  const user = await requireUserOrApiKeyWithOrg(c);
  const agentId = c.req.param("agentId");
  if (!agentId)
    return { error: "Missing agent id" as const, status: 400 as const };
  const agent = await agentSandboxesRepository.findByIdAndOrg(
    agentId,
    user.organization_id,
  );
  if (!agent)
    return { error: "Agent not found" as const, status: 404 as const };
  if (agent.execution_tier !== "shared") {
    return {
      error: "Not a shared-runtime agent" as const,
      status: 404 as const,
    };
  }
  return { agent, agentId };
}

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
