// Handles v1 cloud API v1 eliza agents agentid api conversations conversationid messages stream route traffic with route-local auth expectations.
import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  type CanonicalScopedStreamRequest,
  handleCanonicalScopedAgentStream,
} from "@/lib/services/shared-runtime/canonical-scoped-stream";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * /api/v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/stream
 *
 * SSE chat for a SHARED-runtime agent. The mobile/web chat client probes this
 * `/messages/stream` endpoint first (the agent-server REST conversation contract)
 * and only falls back to the non-stream `POST .../messages` if it 404s. A shared
 * agent runs in-Worker with no agent server, so there is no upstream SSE socket to
 * proxy — instead we run the SAME billed in-Worker turn the non-stream send uses
 * (`elizaSandboxService.bridgeStream` → shared-tier branch → bridgeSharedMessageSend)
 * and emit its reply as SSE. `bridge()` (non-stream) and `bridgeStream()` share the
 * identical findRunningSandbox gate + bridgeSharedMessageSend handler, so any shared
 * agent that serves the non-stream send also serves this.
 *
 * Body shape — NOT token-by-token for the shared tier. bridgeSharedMessageSend
 * produces a fully-materialized reply string, which bridgeStream wraps in a SINGLE
 * SSE frame (one `chunk` + one `done`) via createBridgeSseTextResponse. So a shared
 * reply arrives as one buffered frame, not incrementally. DEDICATED (container)
 * agents are different: their bridgeStream branch proxies a live upstream SSE socket
 * and forwards real token-by-token frames.
 *
 * This route is a true pass-through either way: it returns the `bridgeStream`
 * Response body as-is and never awaits/reads it, so whatever the body yields
 * (single shared frame, or a dedicated agent's token stream) flushes to the
 * Cloudflare edge incrementally without buffering here.
 * Shared-tier + org-scoped (resolveSharedAgent gates auth, org-scope, tier).
 */
const CORS_METHODS = "POST, OPTIONS";

const app = new Hono<AppEnv>();

async function resolveAgentScope(c: Parameters<typeof resolveSharedAgent>[0]) {
  const configured = c.env?.VOICE_REALTIME_ELIZA_AUTHORIZATION;
  const presented = c.req.header("authorization");
  if (configured && presented && timingSafeEqualSecret(presented, configured)) {
    const agentId = c.req.param("agentId") ?? "";
    const orgId = c.req.header("X-Eliza-Organization-Id") ?? "";
    const userId = c.req.header("X-Eliza-User-Id") ?? "";
    const agent = orgId
      ? await agentSandboxesRepository.findByIdAndOrg(agentId, orgId)
      : undefined;
    if (!agent || !userId || agent.user_id !== userId) {
      return {
        error: "Agent not found",
        code: "agent_not_found",
        status: 404 as const,
      };
    }
    return { agentId: agent.id, orgId, agentName: agent.agent_name ?? "Agent" };
  }
  return resolveSharedAgent(c);
}

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

app.post("/", async (c) => {
  const origin = c.req.header("origin");
  const r = await resolveAgentScope(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          error: r.error,
          ...("code" in r ? { code: r.code } : {}),
        },
        { status: r.status },
      ),
      CORS_METHODS,
      origin,
    );
  }

  const conversationId = c.req.param("conversationId") ?? r.agentId;
  const raw: unknown = await c.req.json().catch(() => ({}));
  return handleCanonicalScopedAgentStream({
    agentId: r.agentId,
    orgId: r.orgId,
    conversationId,
    body: raw,
    origin,
  } satisfies CanonicalScopedStreamRequest);
});

export default app;
