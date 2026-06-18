import type { Context } from "hono";

import {
  type AgentSandbox,
  agentSandboxesRepository,
} from "../../../db/repositories/agent-sandboxes";
import type { AppEnv } from "../../../types/cloud-worker-env";
import { requireUserOrApiKeyWithOrg } from "../../auth/workers-hono-auth";

export type ResolvedSharedAgent =
  | { error: string; status: 400 | 404 }
  | { agent: AgentSandbox; agentId: string; orgId: string; agentName: string };

/**
 * Resolve + authorize the SHARED-runtime agent addressed by a request's
 * `:agentId`. The single gate behind every `.../agents/:agentId/api/*` leaf
 * (health, status/catch-all, conversations, messages) so the auth + org-scope +
 * shared-tier check lives in exactly ONE place instead of a per-route copy.
 *
 * Validates the caller's API key/session, scopes the agent to their org, and
 * 404s anything that isn't a shared-tier agent (dedicated agents use their own
 * subdomain REST surface). Returns the superset of fields the leaves read; each
 * caller takes what it needs.
 */
export async function resolveSharedAgent(c: Context<AppEnv>): Promise<ResolvedSharedAgent> {
  const user = await requireUserOrApiKeyWithOrg(c);
  const agentId = c.req.param("agentId");
  if (!agentId) return { error: "Missing agent id", status: 400 };
  const agent = await agentSandboxesRepository.findByIdAndOrg(agentId, user.organization_id);
  if (!agent) return { error: "Agent not found", status: 404 };
  if (agent.execution_tier !== "shared") {
    return { error: "Not a shared-runtime agent", status: 404 };
  }
  return { agent, agentId, orgId: user.organization_id, agentName: agent.agent_name ?? "Eliza" };
}
