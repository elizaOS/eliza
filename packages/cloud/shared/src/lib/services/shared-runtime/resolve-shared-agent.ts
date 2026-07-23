/**
 * Resolves shared-agent identity and tenancy for Cloudflare request handlers.
 *
 * Production chat callers use the cache-only mode: misses schedule
 * authoritative hydration under waitUntil and return retryable unavailability.
 */

import { createHash } from "node:crypto";
import type { Context } from "hono";

import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { AppEnv, RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { ApiError } from "../../api/cloud-worker-errors";
import {
  apiKeyScopeHashPrefix,
  requireUserOrApiKeyWithOrgLookup,
  revalidateSessionScope,
  sessionScopeHashPrefix,
} from "../../auth/workers-hono-auth";
import { cache } from "../../cache/client";
import { CacheKeys, CacheTTL } from "../../cache/keys";
import { logger } from "../../utils/logger";
import { type CachedAgentSandbox, rehydrateCachedAgentDates } from "./cached-agent-dates";
import { isDedicatedBootstrapWindow } from "./dedicated-bootstrap";

export { type CachedAgentSandbox, rehydrateCachedAgentDates } from "./cached-agent-dates";

export type ResolvedSharedAgent =
  | { error: string; status: 400 | 401 | 403 | 404 | 503 }
  | { agent: AgentSandbox; agentId: string; orgId: string; agentName: string };

export interface SharedRuntimeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ResolveSharedAgentOptions {
  /**
   * A production inference request must never hydrate scope from Postgres
   * inline. On a miss, populate the cache under waitUntil and return a
   * retryable warming response.
   */
  cacheOnly?: boolean;
  executionCtx?: SharedRuntimeExecutionContext;
}

export type SharedRuntimeWorkerRequestContext =
  | {
      namespace: RuntimeDurableObjectNamespace;
      executionCtx: SharedRuntimeExecutionContext;
    }
  | {
      error: string;
      code: "shared_runtime_context_unavailable";
      retryable: true;
      status: 503;
    };

/**
 * Resolve the two Cloudflare capabilities required by every production shared
 * chat request. Treating either capability as optional previously turned a
 * deployment/configuration fault into a synchronous legacy database path.
 */
export function resolveSharedRuntimeWorkerRequestContext(
  c: Context<AppEnv>,
): SharedRuntimeWorkerRequestContext {
  const namespace = c.env?.SHARED_RUNTIME_CONVERSATIONS;
  let executionCtx: SharedRuntimeExecutionContext | undefined;
  try {
    const candidate = c.executionCtx;
    if (candidate && typeof candidate.waitUntil === "function") {
      executionCtx = candidate;
    }
  } catch {
    // error-policy:J4 Hono intentionally throws when a route is invoked outside
    // Workers; the caller renders a retryable unavailable response.
    executionCtx = undefined;
  }
  if (!namespace || typeof namespace.getByName !== "function" || !executionCtx) {
    return {
      error: "Shared runtime cache context is unavailable. Retry shortly.",
      code: "shared_runtime_context_unavailable",
      retryable: true,
      status: 503,
    };
  }
  return { namespace, executionCtx };
}

/**
 * What the shared-agent SCOPE cache stores (COLDPATH-FIX-2026-07-21): the two
 * facts the cold auth+scope gate produces — the caller's organization id and
 * the org-scoped agent row. Everything else in the success return is derived
 * cheaply in-memory from these, so a cache hit reproduces the exact same result
 * WITHOUT the two cold Hyperdrive waves (key validation + user/org hydration +
 * agent lookup). Shared agents use bounded sliding refresh; a dedicated agent
 * in its first-bootstrap window uses only the short base TTL so the handoff to
 * its container self-heals quickly.
 */
interface CachedSharedAgentScope {
  orgId: string;
  agent: CachedAgentSandbox;
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
 * Negative scope entry: the cache-only fast lane can NEVER serve this
 * (credential, agentId) pair — the agent is not shared-tier (dedicated,
 * not found, wrong org) or the credential was rejected. Cache-only callers
 * return the stored fail-closed decision instead of re-entering Postgres. The
 * short scope TTL bounds stale availability denials after a tier or credential
 * change; mutation invalidation remains the primary freshness mechanism.
 */
interface NegativeSharedAgentScope {
  unresolvable: true;
  error?: string;
  status?: 400 | 401 | 403 | 404;
  firstWrittenAtMs: number;
}

type SharedAgentScopeCacheEntry = CachedSharedAgentScope | NegativeSharedAgentScope;

function isNegativeScopeEntry(
  entry: SharedAgentScopeCacheEntry | null | undefined,
): entry is NegativeSharedAgentScope {
  return entry != null && (entry as NegativeSharedAgentScope).unresolvable === true;
}

function isCacheableScopeFailureStatus(
  status: number,
): status is NonNullable<NegativeSharedAgentScope["status"]> {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

/**
 * Confirm a scope-cache hit is still authorized without user/org or agent
 * hydration. Cache-only callers validate from the revoke-invalidated API-key
 * cache; administrative callers may use the authoritative validator. The
 * credential must still belong to the cached organization. Session/JWT
 * requests use the separate session revalidation path.
 */
async function revalidateCachedScope(
  c: Context<AppEnv>,
  cachedOrgId: string,
  cacheOnly: boolean,
): Promise<boolean> {
  const apiKey =
    c.req.header("X-API-Key") ||
    c.req.header("x-api-key") ||
    (c.req.header("authorization")?.startsWith("Bearer eliza_")
      ? c.req.header("authorization")?.slice("Bearer ".length).trim()
      : null) ||
    null;
  if (!apiKey) return false;
  const validated = cacheOnly
    ? await cache.get<{
        is_active?: boolean;
        organization_id?: string;
        expires_at?: Date | string | null;
      }>(
        CacheKeys.apiKey.validation(
          createHash("sha256").update(apiKey).digest("hex").substring(0, 16),
        ),
      )
    : await import("../../services/api-keys").then(({ apiKeysService }) =>
        apiKeysService.validateApiKey(apiKey),
      );
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
export async function resolveSharedAgent(
  c: Context<AppEnv>,
  options: ResolveSharedAgentOptions = {},
): Promise<ResolvedSharedAgent> {
  const agentId = c.req.param("agentId");
  if (!agentId) return { error: "Missing agent id", status: 400 };
  const executionCtx = options.executionCtx;
  if (options.cacheOnly && !executionCtx) {
    return {
      error: "Agent authorization cache context is unavailable. Retry shortly.",
      status: 503,
    };
  }

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
  const apiKeyPrefix = await apiKeyScopeHashPrefix(c);
  const sessionPrefix = apiKeyPrefix ? null : await sessionScopeHashPrefix(c);
  const isSessionScope = apiKeyPrefix == null && sessionPrefix != null;
  const scopeKeyPrefix = apiKeyPrefix ?? (sessionPrefix ? `s:${sessionPrefix}` : null);
  const scopeCacheKey = scopeKeyPrefix
    ? CacheKeys.sharedAgentScope.resolve(scopeKeyPrefix, agentId)
    : null;
  if (options.cacheOnly && !scopeCacheKey) {
    return {
      error: "A supported API key or session credential is required.",
      status: 401,
    };
  }
  // A cache HIT reproduces the resolved scope WITHOUT the cold DB waves, but must
  // STILL run the per-request credential gate (see revalidateResolvedScope). This
  // is shared by the direct pre-hydration hit below AND by a single-flight waiter
  // that picks up a scope another concurrent cold caller just populated.
  const revalidateResolvedScope = async (
    cached: CachedSharedAgentScope,
  ): Promise<ResolvedSharedAgent | null> => {
    if (
      !cached?.agent ||
      !cached.orgId ||
      (cached.agent.execution_tier !== "shared" && !isDedicatedBootstrapWindow(cached.agent))
    ) {
      return null;
    }
    // SECURITY: a hit skips the expensive user/org+agent DB hydration, but it
    // must NOT skip the credential gate. API-key path: re-run the (already-
    // cached, revoke-invalidated) key validation + org match. SESSION path:
    // re-run the warm-cached steward JWT verify + confirm it still maps to the
    // SAME steward user the entry was written for. Either way a
    // revoked/expired/re-scoped credential falls back to the authoritative
    // gate inside the 30s TTL window; we only skip the cold DB waves.
    let stillAuthorized: boolean;
    try {
      stillAuthorized = isSessionScope
        ? cached.stewardUserId != null && (await revalidateSessionScope(c, cached.stewardUserId))
        : await revalidateCachedScope(c, cached.orgId, options.cacheOnly === true);
    } catch (error) {
      // error-policy:J4 a cache credential dependency failure cannot authorize
      // the request; cache-only callers receive the explicit warming response.
      logger.warn("[resolveSharedAgent] cached scope revalidation failed", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      stillAuthorized = false;
    }
    if (!stillAuthorized) return null;
    // Restore the DATE contract lost to the cache's JSON round-trip before
    // handing the agent to route consumers (e.g. conversations route calls
    // `agent.created_at.toISOString()`). Without this a cache hit 500s the read
    // (CONVERSATIONS-500-2026-07-22).
    const agent = rehydrateCachedAgentDates(cached.agent);
    return {
      agent,
      agentId,
      orgId: cached.orgId,
      agentName: agent.agent_name ?? "Eliza",
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
    if (!scopeCacheKey || cached.agent.execution_tier !== "shared") return;
    const now = Date.now();
    const firstWrittenAtMs = cached.firstWrittenAtMs ?? now;
    // Do not refresh past the absolute cap; let the entry expire so the agent
    // row self-heals via the authoritative gate.
    if (now - firstWrittenAtMs >= CacheTTL.sharedAgentScope.resolveMaxAgeMs) return;
    const refreshed: CachedSharedAgentScope = { ...cached, firstWrittenAtMs };
    const refresh = cache
      .set(scopeCacheKey, refreshed, CacheTTL.sharedAgentScope.resolve)
      .catch((error) => {
        logger.debug("[resolveSharedAgent] scope cache sliding refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    if (options.executionCtx) options.executionCtx.waitUntil(refresh);
    else void refresh;
  };

  let cachedEntry: SharedAgentScopeCacheEntry | null = null;
  if (scopeCacheKey) {
    try {
      cachedEntry = await cache.get<SharedAgentScopeCacheEntry>(scopeCacheKey);
    } catch (error) {
      // error-policy:J4 a cache outage is an explicit retryable failure on the
      // Worker path; only non-Worker compatibility may use the DB fallback.
      logger.warn("[resolveSharedAgent] scope cache read failed", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (options.cacheOnly) {
        return {
          error: "Agent authorization cache is unavailable. Retry shortly.",
          status: 503,
        };
      }
    }
    if (cachedEntry && isNegativeScopeEntry(cachedEntry)) {
      if (options.cacheOnly) {
        return {
          error: cachedEntry.error ?? "Agent is unavailable to the shared runtime.",
          status: cachedEntry.status ?? 404,
        };
      }
    } else if (cachedEntry) {
      const resolved = await revalidateResolvedScope(cachedEntry);
      if (resolved) {
        slidingRefreshValidatedHit(cachedEntry);
        return resolved;
      }
    }
  }
  const negativeScope = isNegativeScopeEntry(cachedEntry);

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
  // A cold Worker request records either a usable cached scope or an explicit
  // fail-closed decision. The request itself has already returned 503; all
  // authoritative auth, agent, and character reads remain under waitUntil.
  const hydrateScopeEntry = async (): Promise<SharedAgentScopeCacheEntry> => {
    try {
      const { agentSandboxesRepository } = await import("../../../db/repositories/agent-sandboxes");
      const { user, orgLookupResult: agent } = await requireUserOrApiKeyWithOrgLookup(c, (orgId) =>
        agentSandboxesRepository.findByIdAndOrg(agentId, orgId),
      );
      if (!agent) {
        return {
          unresolvable: true,
          error: "Agent not found",
          status: 404,
          firstWrittenAtMs: Date.now(),
        };
      }
      if (agent.execution_tier !== "shared" && !isDedicatedBootstrapWindow(agent)) {
        return {
          unresolvable: true,
          error: "Not a shared-runtime agent",
          status: 404,
          firstWrittenAtMs: Date.now(),
        };
      }
      if (agent.character_id) {
        const { charactersService } = await import("../characters/characters");
        await charactersService.getById(agent.character_id);
      }
      const base =
        isSessionScope && typeof user.steward_id === "string"
          ? {
              orgId: user.organization_id,
              agent,
              stewardUserId: user.steward_id,
            }
          : { orgId: user.organization_id, agent };
      return { ...base, firstWrittenAtMs: Date.now() };
    } catch (error) {
      if (error instanceof ApiError && isCacheableScopeFailureStatus(error.status)) {
        return {
          unresolvable: true,
          error: error.message,
          status: error.status,
          firstWrittenAtMs: Date.now(),
        };
      }
      throw error;
    }
  };

  if (scopeCacheKey && options.cacheOnly) {
    if (!executionCtx) {
      return {
        error: "Agent authorization cache context is unavailable. Retry shortly.",
        status: 503,
      };
    }
    const hydration = (
      cachedEntry
        ? // A stale positive entry that failed revalidation (e.g. cold
          // validation cache, revoked key): getOrSet would return the existing
          // entry without running the loader, so force an overwrite hydration
          // to converge to a fresh positive or a negative entry.
          hydrateScopeEntry().then((entry) =>
            cache.set(scopeCacheKey, entry, CacheTTL.sharedAgentScope.resolve),
          )
        : cache.getOrSet<SharedAgentScopeCacheEntry>(
            scopeCacheKey,
            CacheTTL.sharedAgentScope.resolve,
            hydrateScopeEntry,
            { singleflight: true },
          )
    )
      .then(() => undefined)
      .catch((error) => {
        // error-policy:J7 cache hydration is deliberately off the inference
        // path; the retry remains fail-closed until an authoritative fill wins.
        logger.warn("[resolveSharedAgent] background scope hydration failed", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    executionCtx.waitUntil(hydration);
    return {
      error: "Agent authorization cache is warming. Retry shortly.",
      status: 503,
    };
  }

  if (scopeCacheKey && !negativeScope) {
    const hydrated = await cache
      .getOrSet<SharedAgentScopeCacheEntry>(
        scopeCacheKey,
        CacheTTL.sharedAgentScope.resolve,
        hydrateScopeEntry,
        { singleflight: true },
      )
      .catch(() => null);
    if (hydrated && !isNegativeScopeEntry(hydrated)) {
      const resolved = await revalidateResolvedScope(hydrated);
      // No sliding refresh here: this branch either JUST populated the entry
      // (fresh full TTL) or picked up a scope another cold caller populated
      // microseconds ago (also fresh). The sliding refresh only exists to keep
      // a pre-existing, idled entry warm and runs solely on the direct-get hit.
      if (resolved) return resolved;
    }
  }

  const { agentSandboxesRepository } = await import("../../../db/repositories/agent-sandboxes");
  const { user, orgLookupResult: agent } = await requireUserOrApiKeyWithOrgLookup(c, (orgId) =>
    agentSandboxesRepository.findByIdAndOrg(agentId, orgId),
  );
  if (!agent) return { error: "Agent not found", status: 404 };
  if (agent.execution_tier !== "shared" && !isDedicatedBootstrapWindow(agent)) {
    return { error: "Not a shared-runtime agent", status: 404 };
  }

  // Shared-tier rows use bounded sliding refresh. First-bootstrap dedicated
  // rows use this base TTL only, so the route can stay cache-only while the
  // eventual handoff to the dedicated container still self-heals promptly.
  if (scopeCacheKey) {
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
    const write = cache
      .set(scopeCacheKey, entry, CacheTTL.sharedAgentScope.resolve)
      .catch((error) => {
        logger.debug("[resolveSharedAgent] scope cache write failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    // Register with the Worker execution context where available — a write
    // cancelled at response end would force the next request cold again.
    if (options.executionCtx) options.executionCtx.waitUntil(write);
    else void write;
  }

  return { agent, agentId, orgId: user.organization_id, agentName: agent.agent_name ?? "Eliza" };
}
