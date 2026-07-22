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
  revalidateSessionScope,
  sessionScopeHashPrefix,
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
  /**
   * Steward user id the entry was written for, present ONLY on session-keyed
   * entries (#SHADOW-ACCOUNT-DEBUG). A session-path hit re-verifies the JWT and
   * confirms it still maps to THIS user before serving, so a rotated/re-issued
   * token for a different user can't read a stale entry. Absent on API-key
   * entries (those revalidate via the key's org instead).
   */
  stewardUserId?: string;
  /**
   * Epoch-ms of the entry's FIRST authoritative write (COLDPATH-FIX-2026-07-22).
   * Preserved across sliding-TTL refreshes so the refresh can be capped at
   * `resolveMaxAgeMs` past this instant — a continuously active conversation
   * still self-heals the cached agent row within the cap. Absent on entries
   * written before this field existed (treated as "write now", so a legacy
   * entry simply gets one bounded refresh window before the cap applies).
   */
  firstWrittenAtMs?: number;
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
  // API-key path uses the key-hash prefix; SESSION path (Shadow's own account:
  // steward JWT / cookie) uses the session-token hash under a distinct `s:`
  // namespace so a session hash can never collide with an API-key hash
  // (#SHADOW-ACCOUNT-DEBUG). Whichever credential the request carries wins;
  // requests carrying neither skip the cache and hit the authoritative gate.
  const apiKeyPrefix = await apiKeyScopeHashPrefix(c).catch(() => null);
  const sessionPrefix = apiKeyPrefix ? null : await sessionScopeHashPrefix(c).catch(() => null);
  const isSessionScope = apiKeyPrefix == null && sessionPrefix != null;
  const scopeKeyPrefix = apiKeyPrefix ?? (sessionPrefix ? `s:${sessionPrefix}` : null);
  const scopeCacheKey = scopeKeyPrefix
    ? CacheKeys.sharedAgentScope.resolve(scopeKeyPrefix, agentId)
    : null;
  // A cache HIT reproduces the resolved scope WITHOUT the cold DB waves, but must
  // STILL run the per-request credential gate (see revalidateResolvedScope). This
  // is shared by the direct pre-hydration hit below AND by a single-flight waiter
  // that picks up a scope another concurrent cold caller just populated.
  const revalidateResolvedScope = async (
    cached: CachedSharedAgentScope,
  ): Promise<ResolvedSharedAgent | null> => {
    if (!(cached?.agent && cached.orgId && cached.agent.execution_tier === "shared")) {
      return null;
    }
    // SECURITY: a hit skips the expensive user/org+agent DB hydration, but it
    // must NOT skip the credential gate. API-key path: re-run the (already-
    // cached, revoke-invalidated) key validation + org match. SESSION path:
    // re-run the warm-cached steward JWT verify + confirm it still maps to the
    // SAME steward user the entry was written for. Either way a
    // revoked/expired/re-scoped credential falls back to the authoritative
    // gate inside the 30s TTL window; we only skip the cold DB waves.
    const stillAuthorized = isSessionScope
      ? cached.stewardUserId != null &&
        (await revalidateSessionScope(c, cached.stewardUserId).catch(() => false))
      : await revalidateCachedScope(c, cached.orgId).catch(() => false);
    if (!stillAuthorized) return null;
    return {
      agent: cached.agent,
      agentId,
      orgId: cached.orgId,
      agentName: cached.agent.agent_name ?? "Eliza",
    };
  };

  // SLIDING-TTL refresh on a VALIDATED hit (COLDPATH-FIX-2026-07-22). The
  // residual cold stall after #16743/#16763 is TTL expiry between turns: the
  // 30s absolute TTL is not refreshed on read, so a conversation idled past 30s
  // (demo Q&A pacing — read the reply, think, ask a follow-up — routinely does)
  // re-pays the cold Hyperdrive waves on the NEXT turn. Refreshing the TTL when
  // we serve a still-authorized hit keeps an ACTIVE conversation warm across
  // human think-time. It is bounded: a hit only re-validates the CREDENTIAL, not
  // the cached agent row, so we never refresh past `resolveMaxAgeMs` after the
  // entry's FIRST write — a tier flip / row change still self-heals within the
  // cap even under a continuously active conversation. Best-effort: a refresh
  // failure only means the next turn may re-hydrate; it never fails the turn and
  // never extends an UNAUTHORIZED entry (this runs only after revalidate passed).
  const slidingRefreshValidatedHit = (cached: CachedSharedAgentScope): void => {
    if (!scopeCacheKey) return;
    const now = Date.now();
    const firstWrittenAtMs = cached.firstWrittenAtMs ?? now;
    // Do not refresh past the absolute cap; let the entry expire so the agent
    // row self-heals via the authoritative gate.
    if (now - firstWrittenAtMs >= CacheTTL.sharedAgentScope.resolveMaxAgeMs) return;
    const refreshed: CachedSharedAgentScope = { ...cached, firstWrittenAtMs };
    void cache.set(scopeCacheKey, refreshed, CacheTTL.sharedAgentScope.resolve).catch((error) => {
      logger.debug("[resolveSharedAgent] scope cache sliding refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  if (scopeCacheKey) {
    const cached = await cache.get<CachedSharedAgentScope>(scopeCacheKey).catch(() => null);
    if (cached) {
      const resolved = await revalidateResolvedScope(cached);
      if (resolved) {
        slidingRefreshValidatedHit(cached);
        return resolved;
      }
    }
  }

  // STAMPEDE FIX (CONTENTION-2026-07-22): the scope cache above kills the cold
  // hydration cost for the SECOND-and-later cold caller, but N concurrent cold
  // callers (an audience all chatting the SAME shared demo agent at once) ALL
  // miss simultaneously and stampede `requireUserOrApiKeyWithOrgLookup` +
  // findByIdAndOrg in parallel, saturating the Hyperdrive/DB connection pool.
  // Measured: with 8 concurrent turns on one shared agent exactly one turn's
  // scope-resolve wedged ~8.5-9s (pool-starved) while the rest ran ~1.2s.
  // Single-flight the expensive hydration so only the FIRST concurrent cold
  // caller pays the DB waves and populates the scope; the rest poll for the
  // populated scope (getOrSet singleflight) and then run the SAME per-request
  // credential gate via revalidateResolvedScope — security is unchanged, only
  // the redundant parallel DB hydration is collapsed to one. Falls through to
  // an independent hydration if the lock backend is absent or the holder is
  // slow past the poll window (getOrSet's own fall-through), so this can never
  // hang a turn — worst case it degrades to today's stampede behavior.
  if (scopeCacheKey) {
    const hydrated = await cache
      .getOrSet<CachedSharedAgentScope | null>(
        scopeCacheKey,
        CacheTTL.sharedAgentScope.resolve,
        async () => {
          const { user, orgLookupResult: agent } = await requireUserOrApiKeyWithOrgLookup(
            c,
            (orgId) => agentSandboxesRepository.findByIdAndOrg(agentId, orgId),
          );
          // Only a settled shared-tier agent is cacheable (never the
          // time-sensitive dedicated-bootstrap window). A non-cacheable or
          // not-found result returns null so getOrSet does NOT populate the
          // cache, and this caller falls through to the authoritative path
          // below to produce the correct 404 / bootstrap handling.
          if (!agent || agent.execution_tier !== "shared") return null;
          const base =
            isSessionScope && typeof user.steward_id === "string"
              ? { orgId: user.organization_id, agent, stewardUserId: user.steward_id }
              : { orgId: user.organization_id, agent };
          return { ...base, firstWrittenAtMs: Date.now() };
        },
        { singleflight: true },
      )
      .catch(() => null);
    if (hydrated) {
      const resolved = await revalidateResolvedScope(hydrated);
      // No sliding refresh here: this branch either JUST populated the entry
      // (fresh full TTL) or picked up a scope another cold caller populated
      // microseconds ago (also fresh). The sliding refresh only exists to keep
      // a pre-existing, idled entry warm and runs solely on the direct-get hit.
      if (resolved) return resolved;
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
    // Session-keyed entries carry the steward user id so a hit can re-verify the
    // JWT maps to the same user without a user/org DB read (#SHADOW-ACCOUNT-DEBUG).
    // Only write it when we actually have it (session path + a steward-linked
    // user); its absence just means the hit safely falls back to the slow gate.
    const entry: CachedSharedAgentScope = {
      ...(isSessionScope && typeof user.steward_id === "string"
        ? { orgId: user.organization_id, agent, stewardUserId: user.steward_id }
        : { orgId: user.organization_id, agent }),
      firstWrittenAtMs: Date.now(),
    };
    void cache.set(scopeCacheKey, entry, CacheTTL.sharedAgentScope.resolve).catch((error) => {
      logger.debug("[resolveSharedAgent] scope cache write failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return { agent, agentId, orgId: user.organization_id, agentName: agent.agent_name ?? "Eliza" };
}
