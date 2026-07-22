/**
 * Shared-runtime resolver coverage proves cold-scope hydration stays on the
 * org-scoped auth path while preserving the shared-tier and bootstrap-window
 * routing boundaries consumed by the Cloud agent REST adapter.
 *
 * COLDPATH-FIX-2026-07-21 also pins the short-TTL scope cache: a fresh session's
 * FIRST cold hit runs the full authoritative gate and populates the cache; the
 * SECOND hit skips the cold user/org+agent Hyperdrive waves BUT still re-runs the
 * revoke-invalidated credential validation and the org-match check, so a revoked
 * or re-scoped key can never be served a stale agent, and a non-shared/bootstrap
 * agent is never cached.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrgLookup = mock(
  async <T>(_: unknown, lookup: (organizationId: string) => Promise<T>) => ({
    user: { organization_id: "org-1", steward_id: "steward-user-1" },
    orgLookupResult: await lookup("org-1"),
  }),
);
const findByIdAndOrg = mock(async () => null);

// Scope-cache key derivation for the CURRENT request. Default: an API-key
// request whose hash-prefix is stable, so hit/miss can be exercised.
let scopeHashPrefixBehavior: () => Promise<string | null> = async () => "keyhashpref0000";
const apiKeyScopeHashPrefix = mock(() => scopeHashPrefixBehavior());

// Session-path derivation (#SHADOW-ACCOUNT-DEBUG). Default null => API-key path
// unless a test opts into the session shape.
let sessionHashPrefixBehavior: () => Promise<string | null> = async () => null;
const sessionScopeHashPrefix = mock(() => sessionHashPrefixBehavior());
let sessionRevalidateBehavior: (cachedStewardUserId: string) => Promise<boolean> = async () => true;
const revalidateSessionScope = mock((_: unknown, cachedStewardUserId: string) =>
  sessionRevalidateBehavior(cachedStewardUserId),
);

mock.module("../../auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrgLookup,
  apiKeyScopeHashPrefix,
  sessionScopeHashPrefix,
  revalidateSessionScope,
}));

mock.module("../../../db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findByIdAndOrg,
  },
}));

// In-memory cache double: records reads/writes so the tests can assert the
// second cold hit skips the DB waves and the not-OK shapes are never cached.
const cacheStore = new Map<string, unknown>();
const cacheGet = mock(async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null));
const cacheSet = mock(async (key: string, value: unknown, _ttlSeconds?: number) => {
  cacheStore.set(key, value);
});
// Single-flight double: an in-process lock so N concurrent misses run the loader
// EXACTLY ONCE (the real getOrSet uses a distributed SET NX lock). Waiters await
// the in-flight loader and reuse its result — the property the stampede fix relies
// on. Only populates the cache when the loader returns a non-null value (matches
// the real getOrSet contract the fix depends on for not caching a 404/null scope).
const inFlight = new Map<string, Promise<unknown>>();
const cacheGetOrSet = mock(async (key: string, _ttl: number, loader: () => Promise<unknown>) => {
  if (cacheStore.has(key)) return cacheStore.get(key);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = (async () => {
    const fresh = await loader();
    // Real getOrSet populates via this.set() on a non-null load — route through
    // the cacheSet double so existing "cold miss writes the scope once"
    // assertions still observe the populate through the same mock.
    if (fresh !== null && fresh !== undefined) await cacheSet(key, fresh);
    return fresh;
  })();
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
});
mock.module("../../cache/client", () => ({
  cache: { get: cacheGet, set: cacheSet, getOrSet: cacheGetOrSet },
}));

// validateApiKey double for the cache-HIT re-validation gate.
let validateBehavior: () => Promise<unknown> = async () => ({
  is_active: true,
  organization_id: "org-1",
  expires_at: null,
});
const validateApiKey = mock(() => validateBehavior());
mock.module("../../services/api-keys", () => ({
  apiKeysService: { validateApiKey },
}));

mock.module("../../utils/logger", () => ({
  logger: { debug: () => {}, warn: () => {}, error: () => {}, info: () => {} },
}));

const { resolveSharedAgent } = await import("./resolve-shared-agent");
const { CacheTTL } = await import("../../cache/keys");

function contextWithAgentId(agentId?: string, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: {
      param: (name: string) => (name === "agentId" ? agentId : undefined),
      header: (name: string) => lower[name.toLowerCase()],
    },
  };
}

// A request carrying an API key so the scope-cache HIT path (which re-validates
// the presented key) can run end to end.
function apiKeyContext(agentId?: string) {
  return contextWithAgentId(agentId, { "X-API-Key": "eliza_testkey" });
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    organization_id: "org-1",
    execution_tier: "shared",
    status: "running",
    bridge_url: null,
    agent_name: "Shared Agent",
    ...overrides,
  };
}

beforeEach(() => {
  requireUserOrApiKeyWithOrgLookup.mockClear();
  findByIdAndOrg.mockClear();
  findByIdAndOrg.mockResolvedValue(null);
  cacheGet.mockClear();
  cacheSet.mockClear();
  cacheGetOrSet.mockClear();
  inFlight.clear();
  validateApiKey.mockClear();
  cacheStore.clear();
  sessionScopeHashPrefix.mockClear();
  revalidateSessionScope.mockClear();
  scopeHashPrefixBehavior = async () => "keyhashpref0000";
  sessionHashPrefixBehavior = async () => null;
  sessionRevalidateBehavior = async () => true;
  validateBehavior = async () => ({ is_active: true, organization_id: "org-1", expires_at: null });
});

describe("resolveSharedAgent", () => {
  test("returns 400 without auth or repository work when the route param is missing", async () => {
    await expect(resolveSharedAgent(contextWithAgentId() as never)).resolves.toEqual({
      error: "Missing agent id",
      status: 400,
    });
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
  });

  test("uses the overlapped org lookup to resolve a shared agent", async () => {
    findByIdAndOrg.mockResolvedValue(agent());

    await expect(resolveSharedAgent(apiKeyContext("agent-1") as never)).resolves.toMatchObject({
      agentId: "agent-1",
      orgId: "org-1",
      agentName: "Shared Agent",
    });
    expect(findByIdAndOrg).toHaveBeenCalledWith("agent-1", "org-1");
  });

  test("allows a dedicated agent only during its first bootstrap window", async () => {
    findByIdAndOrg.mockResolvedValue(
      agent({
        execution_tier: "dedicated-lazy",
        status: "provisioning",
        agent_name: null,
      }),
    );

    await expect(resolveSharedAgent(apiKeyContext("agent-1") as never)).resolves.toMatchObject({
      agentName: "Eliza",
      agentId: "agent-1",
    });
  });

  test("rejects non-shared agents outside the bootstrap window", async () => {
    findByIdAndOrg.mockResolvedValue(
      agent({
        execution_tier: "dedicated-lazy",
        status: "running",
        bridge_url: "https://agent.example.test",
      }),
    );

    await expect(resolveSharedAgent(apiKeyContext("agent-1") as never)).resolves.toEqual({
      error: "Not a shared-runtime agent",
      status: 404,
    });
  });

  test("returns 404 when no org-scoped agent exists", async () => {
    await expect(resolveSharedAgent(apiKeyContext("agent-missing") as never)).resolves.toEqual({
      error: "Agent not found",
      status: 404,
    });
  });
});

describe("resolveSharedAgent scope cache (COLDPATH-FIX-2026-07-21)", () => {
  test("first cold hit runs the full gate and populates the cache", async () => {
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(apiKeyContext("agent-1") as never);

    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledTimes(1);
    // Cached bundle carries the org + agent so the next hit skips the DB waves.
    const [, cachedValue] = cacheSet.mock.calls[0];
    expect(cachedValue).toMatchObject({ orgId: "org-1" });
  });

  test("second cold-session hit skips the user/org+agent DB waves", async () => {
    findByIdAndOrg.mockResolvedValue(agent());

    // Populate.
    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();
    findByIdAndOrg.mockClear();

    // Second hit: served from cache. The expensive cold path must NOT run.
    const result = await resolveSharedAgent(apiKeyContext("agent-1") as never);

    expect(result).toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    // The credential was STILL re-validated on the hit (revoke gate preserved).
    expect(validateApiKey).toHaveBeenCalled();
  });

  test("a revoked key on a cache hit falls back to the full gate (never served stale)", async () => {
    findByIdAndOrg.mockResolvedValue(agent());
    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();

    // Key revoked between turns: validation now returns inactive.
    validateBehavior = async () => ({
      is_active: false,
      organization_id: "org-1",
      expires_at: null,
    });

    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    // Fell back to the authoritative gate rather than serving the cached agent.
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
  });

  test("a re-scoped key (different org) on a cache hit does not read another org's agent", async () => {
    findByIdAndOrg.mockResolvedValue(agent());
    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();

    // Key moved to a different org (detach): the cached org no longer matches.
    validateBehavior = async () => ({
      is_active: true,
      organization_id: "org-2",
      expires_at: null,
    });

    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
  });

  test("a dedicated-bootstrap agent is never cached (time-sensitive eligibility)", async () => {
    findByIdAndOrg.mockResolvedValue(
      agent({ execution_tier: "dedicated-lazy", status: "provisioning" }),
    );

    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    // Served (bootstrap window) but NOT written to the scope cache.
    expect(cacheSet).not.toHaveBeenCalled();
  });

  test("a request carrying NEITHER an api key nor a session never touches the scope cache", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => null;
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
    // Authoritative gate still ran.
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
  });
});

describe("resolveSharedAgent sliding TTL (COLDPATH-FIX-2026-07-22)", () => {
  test("a validated hit re-writes the entry with the full TTL (keeps active convo warm)", async () => {
    findByIdAndOrg.mockResolvedValue(agent());

    // Populate (authoritative write #1).
    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    expect(cacheSet).toHaveBeenCalledTimes(1);
    const firstWrittenAtMs = (
      cacheStore.get(cacheStore.keys().next().value) as { firstWrittenAtMs: number }
    ).firstWrittenAtMs;
    expect(typeof firstWrittenAtMs).toBe("number");
    cacheSet.mockClear();
    requireUserOrApiKeyWithOrgLookup.mockClear();
    findByIdAndOrg.mockClear();

    // Second hit within the cap: served from cache AND refreshes the TTL.
    const result = await resolveSharedAgent(apiKeyContext("agent-1") as never);
    expect(result).toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    // No cold DB waves on the hit.
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    // The hit re-wrote the entry with the resolve TTL (sliding refresh).
    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [, refreshedValue, ttlSeconds] = cacheSet.mock.calls[0];
    expect(ttlSeconds).toBe(CacheTTL.sharedAgentScope.resolve);
    // firstWrittenAtMs is PRESERVED across the refresh so the cap still bounds it.
    expect((refreshedValue as { firstWrittenAtMs: number }).firstWrittenAtMs).toBe(
      firstWrittenAtMs,
    );
  });

  test("a hit past the absolute cap is NOT refreshed (agent row self-heals within the cap)", async () => {
    findByIdAndOrg.mockResolvedValue(agent());
    await resolveSharedAgent(apiKeyContext("agent-1") as never);

    // Simulate a continuously active conversation that has been warm longer than
    // the cap: back-date the entry's firstWrittenAtMs past resolveMaxAgeMs.
    const key = cacheStore.keys().next().value as string;
    const stored = cacheStore.get(key) as { firstWrittenAtMs: number };
    stored.firstWrittenAtMs = Date.now() - CacheTTL.sharedAgentScope.resolveMaxAgeMs - 1;
    cacheSet.mockClear();
    requireUserOrApiKeyWithOrgLookup.mockClear();

    const result = await resolveSharedAgent(apiKeyContext("agent-1") as never);
    // Still served from cache this turn (credential re-validated), but NOT
    // refreshed — so the entry expires on schedule and the next miss re-hydrates
    // the agent row through the authoritative gate.
    expect(result).toMatchObject({ agentId: "agent-1" });
    expect(cacheSet).not.toHaveBeenCalled();
  });

  test("a revoked key on a hit is NOT refreshed (never extends an unauthorized entry)", async () => {
    findByIdAndOrg.mockResolvedValue(agent());
    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    cacheSet.mockClear();
    // Key revoked between turns.
    validateBehavior = async () => ({
      is_active: false,
      organization_id: "org-1",
      expires_at: null,
    });

    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    // The hit failed revalidation -> fell through to the authoritative gate,
    // which re-wrote the entry (row still shared) ONCE. The sliding refresh must
    // NOT have fired on the failed hit (it runs only after revalidate passes),
    // so the only write is the authoritative populate, not a hit-refresh.
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalled();
  });
});

describe("resolveSharedAgent stampede single-flight (CONTENTION-2026-07-22)", () => {
  test("N concurrent cold callers hydrate the scope EXACTLY once", async () => {
    // Repro of the demo-day audience pile-on: N callers hit the SAME shared
    // agent's scope with a cold cache at once. Without single-flight all N run
    // the expensive user/org+agent hydration in parallel and starve the DB pool
    // (one turn wedged ~8.5s on staging). The fix collapses them to one loader.
    let resolveGate: (() => void) | null = null;
    const gateOpened = new Promise<void>((r) => {
      resolveGate = r;
    });
    // Make the expensive hydration hang until we release it, so all N callers
    // are provably in-flight simultaneously before any completes.
    requireUserOrApiKeyWithOrgLookup.mockImplementation(async (_c, lookup) => {
      await gateOpened;
      const a = agent();
      const orgLookupResult = await lookup((a as { organization_id: string }).organization_id);
      return { user: { organization_id: "org-1" }, orgLookupResult };
    });
    findByIdAndOrg.mockResolvedValue(agent());

    const N = 8;
    const inflightCalls = Array.from({ length: N }, () =>
      resolveSharedAgent(apiKeyContext("agent-1") as never),
    );
    // All callers have entered; release the single hydration.
    resolveGate?.();
    const results = await Promise.all(inflightCalls);

    // Every caller resolves correctly...
    for (const r of results) expect(r).toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    // ...but the expensive DB hydration ran ONCE, not N times.
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
    // The scope was populated exactly once.
    expect(cacheSet).toHaveBeenCalledTimes(1);

    // Restore the default implementation (mockClear keeps impls across tests).
    requireUserOrApiKeyWithOrgLookup.mockImplementation(
      async (_c: unknown, lookup: (o: string) => unknown) => ({
        user: { organization_id: "org-1", steward_id: "steward-user-1" },
        orgLookupResult: await lookup("org-1"),
      }),
    );
  });
});

describe("resolveSharedAgent SESSION scope cache (SHADOW-ACCOUNT-DEBUG)", () => {
  // Shadow's own account authenticates by steward JWT / cookie, not an API key,
  // so the API-key-only scope cache used to skip him entirely -> he paid the
  // cold user/org+agent Hyperdrive waves on EVERY turn (the felt 3-4s warm AND
  // cold). These pin the session-keyed cache that closes that gap.

  test("first cold session hit runs the full gate and caches with the steward user id", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(contextWithAgentId("agent-1") as never);

    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [cacheKey, cachedValue] = cacheSet.mock.calls[0];
    // Session key is namespaced with `s:` so it can't collide with an api-key hash.
    expect(String(cacheKey)).toContain("s:sesshashpref0000");
    expect(cachedValue).toMatchObject({
      orgId: "org-1",
      stewardUserId: "steward-user-1",
    });
  });

  test("second session hit skips the cold DB waves after re-verifying the JWT", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    findByIdAndOrg.mockResolvedValue(agent());

    // Populate.
    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();
    findByIdAndOrg.mockClear();
    // The populate goes through the single-flight hydration (getOrSet), which
    // re-runs the credential gate once on the just-hydrated scope (cheap/warm,
    // strictly safer). Clear it so the assertion below isolates the SECOND hit.
    revalidateSessionScope.mockClear();

    // Second hit: served from cache, no user/org+agent hydration.
    const result = await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    expect(result).toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    // But the credential gate STILL ran (JWT re-verified against the cached user).
    expect(revalidateSessionScope).toHaveBeenCalledTimes(1);
    expect(revalidateSessionScope.mock.calls[0][1]).toBe("steward-user-1");
  });

  test("a session hit whose token no longer verifies falls back to the full gate", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();

    // Token now invalid / re-issued for a different user.
    sessionRevalidateBehavior = async () => false;
    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    // Not served from cache -> authoritative gate re-ran.
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
  });

  test("the api-key path is preferred over session when both are present", async () => {
    // Both derivations available; api-key wins, session cache is not consulted.
    scopeHashPrefixBehavior = async () => "keyhashpref0000";
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(apiKeyContext("agent-1") as never);
    const [cacheKey] = cacheSet.mock.calls[0];
    expect(String(cacheKey)).not.toContain("s:");
    expect(revalidateSessionScope).not.toHaveBeenCalled();
  });
});
