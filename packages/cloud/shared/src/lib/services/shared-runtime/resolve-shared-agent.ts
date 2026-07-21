// Coordinates cloud service resolve shared agent behavior behind route handlers.
import type { Context } from "hono";

import {
  type AgentSandbox,
  agentSandboxesRepository,
} from "../../../db/repositories/agent-sandboxes";
import type { AppEnv } from "../../../types/cloud-worker-env";
import {
  apiKeyScopeHashPrefix,
  requireUserOrApiKeyWithOrgLookup,
} from "../../auth/workers-hono-auth";
import { cache } from "../../cache/client";
import { CacheKeys, CacheTTL } from "../../cache/keys";
import { logger } from "../../utils/logger";
import { isDedicatedBootstrapWindow } from "./dedicated-bootstrap";

export type ResolvedSharedAgent =
  | { error: string; status: 400 | 404 }
  | { agent: AgentSandbox; agentId: string; orgId: string; agentName: string };

/**
 * What the shared-agent SCOPE cache stores (COLDPATH-FIX-2026-07-21): the two
 * facts the cold auth+scope gate produces — the caller's organization id and
 * the org-scoped agent row. Everything else in the success return is derived
 * cheaply in-memory from these, so a cache hit reproduces the exact same result
 * WITHOUT the two cold Hyperdrive waves (key validation + user/org hydration +
 * agent lookup). Only cached for a settled SHARED-tier agent — never for the
 * time-sensitive dedicated-bootstrap window, whose eligibility flips as the
 * container boots.
 */
interface CachedSharedAgentScope {
  orgId: string;
  agent: AgentSandbox;
}

/**
 * Confirm a scope-cache HIT is still authorized WITHOUT the cold user/org+agent
 * hydration (COLDPATH-FIX-2026-07-21). Validates the presented API key via the
 * revoke-invalidated validation cache (a 1-read warm check, or one cold DB trip
 * on a genuinely cold validation entry) and confirms it still belongs to the
 * cached org. Returns false on any not-OK state so the caller falls back to the
 * full authoritative gate — the exact 401/403 taxonomy is preserved, we only
 * fast-path the HAPPY case. Session/JWT requests never reach here (no api key).
 */
async function revalidateCachedScope(c: Context<AppEnv>, cachedOrgId: string): Promise<boolean> {
  const apiKey =
    c.req.header("X-API-Key") ||
    c.req.header("x-api-key") ||
    (c.req.header("authorization")?.startsWith("Bearer eliza_")
      ? c.req.header("authorization")?.slice("Bearer ".length).trim()
      : null) ||
    null;
  if (!apiKey) return false;
  const { apiKeysService } = await import("../../services/api-keys");
  const validated = await apiKeysService.validateApiKey(apiKey);
  if (!validated || !validated.is_active) return false;
  if (validated.expires_at && new Date(validated.expires_at) < new Date()) return false;
  // The key must still be scoped to the org the cached agent belongs to. A
  // detach/re-scope changes organization_id, so a stale cross-org read fails here.
  return validated.organization_id === cachedOrgId;
}

/**
 * Resolve + authorize the SHARED-runtime agent addressed by a request's
 * `:agentId`. The single gate behind every `.../agents/:agentId/api/*` leaf
 * (health, status/catch-all, conversations, messages) so the auth + org-scope +
 * shared-tier check lives in exactly ONE place instead of a per-route copy.
 *
 * Validates the caller's API key/session, scopes the agent to their org, and
 * serves two cases: a shared-tier agent (its whole life), and a DEDICATED agent
 * still in its first-provision bootstrap window (so a new user can chat
 * immediately while the container boots — see dedicated-bootstrap.ts). A
 * dedicated agent that is already running, asleep, or errored 404s here and uses
 * its own subdomain REST surface instead. Returns the superset of fields the
 * leaves read; each caller takes what it needs.
 */
export async function resolveSharedAgent(c: Context<AppEnv>): Promise<ResolvedSharedAgent> {
  const agentId = c.req.param("agentId");
  if (!agentId) return { error: "Missing agent id", status: 400 };

  // COLD-PATH fast lane (COLDPATH-FIX-2026-07-21): on the API-key path, a fresh
  // browser session pays 2 serial cold Hyperdrive waves here (key validation +
  // user/org hydration + agent lookup) = the measured 1–4.4s pre-inference
  // stall. A short-TTL scope cache keyed by (key-hash, agentId) lets the second
  // cold-session hit (or a composer-mount prewarm) skip both waves. Miss → the
  // authoritative gate below runs unchanged, so this only removes latency.
  const scopeKeyPrefix = await apiKeyScopeHashPrefix(c).catch(() => null);
  const scopeCacheKey = scopeKeyPrefix
    ? CacheKeys.sharedAgentScope.resolve(scopeKeyPrefix, agentId)
    : null;
  if (scopeCacheKey) {
    const cached = await cache.get<CachedSharedAgentScope>(scopeCacheKey).catch(() => null);
    if (cached?.agent && cached.orgId && cached.agent.execution_tier === "shared") {
      // SECURITY: a hit skips the expensive user/org+agent DB hydration, but it
      // must NOT skip the credential gate. Re-run the (already-cached,
      // revoke-invalidated) API-key validation so a revoked/expired/inactive key
      // still 401s inside the TTL window, and confirm the key still resolves to
      // the SAME org the cached agent is scoped to (a detached/re-scoped key must
      // not read another org's agent from a stale entry). Only then serve the
      // cached agent row — the two cold Hyperdrive waves are what we skip, never
      // the authorization decision.
      const stillAuthorized = await revalidateCachedScope(c, cached.orgId).catch(() => false);
      if (stillAuthorized) {
        return {
          agent: cached.agent,
          agentId,
          orgId: cached.orgId,
          agentName: cached.agent.agent_name ?? "Eliza",
        };
      }
    }
  }

  const { user, orgLookupResult: agent } = await requireUserOrApiKeyWithOrgLookup(c, (orgId) =>
    agentSandboxesRepository.findByIdAndOrg(agentId, orgId),
  );
  if (!agent) return { error: "Agent not found", status: 404 };
  if (agent.execution_tier !== "shared" && !isDedicatedBootstrapWindow(agent)) {
    return { error: "Not a shared-runtime agent", status: 404 };
  }

  // Populate the scope cache ONLY for a settled shared-tier agent (never the
  // dedicated-bootstrap window, whose eligibility is time-sensitive as the
  // container boots). Best-effort: a cache write failure must not fail the turn.
  if (scopeCacheKey && agent.execution_tier === "shared") {
    void cache
      .set(
        scopeCacheKey,
        { orgId: user.organization_id, agent } satisfies CachedSharedAgentScope,
        CacheTTL.sharedAgentScope.resolve,
      )
      .catch((error) => {
        logger.debug("[resolveSharedAgent] scope cache write failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  return { agent, agentId, orgId: user.organization_id, agentName: agent.agent_name ?? "Eliza" };
}
