import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
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

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
    );
  }
  const conversationId = c.req.param("conversationId") ?? r.agentId;
  const body = await sharedRestMessagesGet(r.agentId, conversationId);
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
  const conversationId = c.req.param("conversationId") ?? r.agentId;
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
    conversationId,
    text,
    r.agentName,
  );
  return applyCorsHeaders(Response.json(result), CORS_METHODS);
});

export default app;
