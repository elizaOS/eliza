import { type Context, Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  sharedRestMessageSend,
  sharedRestMessagesGet,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * /api/v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages
 *
 * REST chat for a SHARED-runtime agent. GET returns the persisted turn history
 * (read from the bridge's KV channel); POST forwards the user text to the shared
 * bridge `message.send` (which runs the turn, persists history, and bills) and
 * returns the assistant reply. Shared-tier + org-scoped.
 */
const CORS_METHODS = "GET, POST, OPTIONS";

const app = new Hono<AppEnv>();

type Resolved =
  | { error: string; status: 400 | 404 }
  | {
      orgId: string;
      agentId: string;
      conversationId: string;
      agentName: string;
    };

async function resolveSharedAgent(c: Context<AppEnv>): Promise<Resolved> {
  const user = await requireUserOrApiKeyWithOrg(c);
  const agentId = c.req.param("agentId");
  const conversationId = c.req.param("conversationId");
  if (!agentId || !conversationId) {
    return { error: "Missing agent or conversation id", status: 400 };
  }
  const agent = await agentSandboxesRepository.findByIdAndOrg(
    agentId,
    user.organization_id,
  );
  if (!agent) return { error: "Agent not found", status: 404 };
  if (agent.execution_tier !== "shared") {
    return { error: "Not a shared-runtime agent", status: 404 };
  }
  return {
    orgId: user.organization_id,
    agentId,
    conversationId,
    agentName: agent.agent_name ?? "Eliza",
  };
}

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
    );
  }
  const body = await sharedRestMessagesGet(r.agentId, r.conversationId);
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
  const raw: unknown = await c.req.json().catch(() => ({}));
  const text =
    raw &&
    typeof raw === "object" &&
    typeof (raw as { text?: unknown }).text === "string"
      ? (raw as { text: string }).text
      : "";
  if (!text.trim()) {
    return applyCorsHeaders(
      Response.json(
        { success: false, error: "text is required" },
        { status: 400 },
      ),
      CORS_METHODS,
    );
  }
  const result = await sharedRestMessageSend(
    r.agentId,
    r.orgId,
    r.conversationId,
    text,
    r.agentName,
  );
  return applyCorsHeaders(Response.json(result), CORS_METHODS);
});

export default app;
