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
const VOICE_AGENT_HEADER = "X-Eliza-Agent-Id";
const VOICE_CONVERSATION_HEADER = "X-Eliza-Conversation-Id";
const VOICE_ORGANIZATION_HEADER = "X-Eliza-Organization-Id";
const VOICE_USER_HEADER = "X-Eliza-User-Id";

const app = new Hono<AppEnv>();

function nowMs(): number {
  return performance.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

async function resolveAgentScope(c: Parameters<typeof resolveSharedAgent>[0]) {
  const configured = c.env?.VOICE_REALTIME_ELIZA_AUTHORIZATION;
  const presented = c.req.header("authorization");
  if (configured && presented && timingSafeEqualSecret(presented, configured)) {
    const agentId = c.req.param("agentId") ?? "";
    const conversationId = c.req.param("conversationId") ?? "";
    const scopedAgentId = c.req.header(VOICE_AGENT_HEADER) ?? "";
    const scopedConversationId = c.req.header(VOICE_CONVERSATION_HEADER) ?? "";
    const orgId = c.req.header(VOICE_ORGANIZATION_HEADER) ?? "";
    const userId = c.req.header(VOICE_USER_HEADER) ?? "";
    if (
      !agentId ||
      !conversationId ||
      scopedAgentId !== agentId ||
      scopedConversationId !== conversationId ||
      !orgId ||
      !userId
    ) {
      return {
        error: "Agent not found",
        code: "agent_not_found",
        status: 404 as const,
      };
    }
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
    return {
      agentId: agent.id,
      orgId,
      userId,
      agentName: agent.agent_name ?? "Agent",
    };
  }
  return resolveSharedAgent(c);
}

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

app.post("/", async (c) => {
  const origin = c.req.header("origin");
  const scopeStartedAt = nowMs();
  const scopePromise = resolveAgentScope(c).then((result) => ({
    result,
    durationMs: elapsedMs(scopeStartedAt),
  }));
  const bodyStartedAt = nowMs();
  const bodyPromise = c.req
    .json()
    .catch(() => {
      // error-policy:J3 untrusted-input sanitizing. Match the canonical stream
      // contract: malformed JSON is an invalid request body, not a fabricated
      // successful turn.
      return {};
    })
    .then((body: unknown) => ({
      body,
      durationMs: elapsedMs(bodyStartedAt),
    }));

  const [
    { result: r, durationMs: scopeMs },
    { body: raw, durationMs: bodyMs },
  ] = await Promise.all([scopePromise, bodyPromise]);
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
  // Workers only: pass an executionCtx so the shared turn defers its billing
  // tail off the SSE `done` path via waitUntil. Hono's executionCtx getter
  // THROWS outside a Worker (tests, Node) — degrade to undefined there so the
  // turn settles inline, preserving fully-synchronous behavior. Mirrors the
  // non-stream POST .../messages route.
  let executionCtx: CanonicalScopedStreamRequest["executionCtx"];
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  return handleCanonicalScopedAgentStream({
    agentId: r.agentId,
    orgId: r.orgId,
    agent: r.agent,
    conversationId,
    ...("userId" in r ? { userId: r.userId } : {}),
    body: raw,
    origin,
    timings: {
      scope: scopeMs,
      body: bodyMs,
    },
    ...(executionCtx ? { executionCtx } : {}),
  } satisfies CanonicalScopedStreamRequest);
});

export default app;
