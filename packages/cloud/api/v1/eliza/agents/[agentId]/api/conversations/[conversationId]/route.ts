// Handles v1 cloud API v1 eliza agents agentid api conversations conversationid route traffic with route-local auth expectations.
import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestConversationDelete,
  sharedRestConversationUpdate,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * /api/v1/eliza/agents/[agentId]/api/conversations/[conversationId]
 *
 * Compatibility surface for a SHARED-runtime agent's canonical conversation.
 * The app patches conversation titles/metadata in the background after a chat
 * turn, and may delete empty/previous conversations during cleanup. Shared
 * agents do not have an agent-server conversation store, so PATCH/DELETE are
 * accepted as no-ops.
 */
const CORS_METHODS = "PATCH, DELETE, OPTIONS";

const app = new Hono<AppEnv>();

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

app.patch("/", async (c) => {
  const origin = c.req.header("origin");
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
      origin,
    );
  }

  const raw = await c.req.json().catch(() => null);
  const body =
    raw && typeof raw === "object" ? (raw as { title?: unknown }) : null;
  return applyCorsHeaders(
    Response.json(
      sharedRestConversationUpdate(
        r.agentId,
        r.agent.agent_name ?? "Eliza",
        r.agent.created_at.toISOString(),
        body,
      ),
    ),
    CORS_METHODS,
    origin,
  );
});

app.delete("/", async (c) => {
  const origin = c.req.header("origin");
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
      origin,
    );
  }

  return applyCorsHeaders(
    Response.json(sharedRestConversationDelete()),
    CORS_METHODS,
    origin,
  );
});

export default app;
