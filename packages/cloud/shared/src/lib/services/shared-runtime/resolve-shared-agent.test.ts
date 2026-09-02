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
import { createHash } from "node:crypto";

const requireUserOrApiKeyWithOrgLookup = mock(
  async <T>(_: unknown, lookup: (organizationId: string) => Promise<T>) => ({
    user: { organization_id: "org-1", steward_id: "steward-user-1" },
    orgLookupResult: await lookup("org-1"),
  }),
);
const findByIdAndOrg = mock(async () => null);
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
  created_at: new Date("2026-01-01T00:00:00.000Z"),
}));

// Scope-cache key derivation for the CURRENT request. Default: an API-key
// request whose hash-prefix is stable, so hit/miss can be exercised.
let scopeHashPrefixBehavior: () => Promise<string | null> = async () => "keyhashpref0000";
const apiKeyScopeHashPrefix = mock(() => scopeHashPrefixBehavior());

// Session-path derivation (#SHADOW-ACCOUNT-DEBUG). Default null => API-key path
// unless a test opts into the session shape.
let sessionHashPrefixBehavior: () => Promise<string | null> = async () => null;
const sessionScopeHashPrefix = mock(() => sessionHashPrefixBehavior());
let sessionRevalidateBehavior: (cachedStewardUserId: string) => Promise<boolean> = async () => true;
const revalidateSessionScope = mock(
  (_: unknown, cachedStewardUserId: string, _cachedOrganizationId?: string) =>
    sessionRevalidateBehavior(cachedStewardUserId),
);
let stagingSessionCandidateBehavior = false;
const isStagingSessionScopeCandidate = mock(() => stagingSessionCandidateBehavior);

mock.module("../../auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
  requireUserOrApiKeyWithOrgLookup,
  apiKeyScopeHashPrefix,
  sessionScopeHashPrefix,
  revalidateSessionScope,
  isStagingSessionScopeCandidate,
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
const cacheDel = mock(async (key: string) => {
  cacheStore.delete(key);
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
  cache: { get: cacheGet, set: cacheSet, del: cacheDel, getOrSet: cacheGetOrSet },
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

const warmInferenceAdmissionSnapshot = mock(async () => undefined);
mock.module("../inference-admission-snapshot", () => ({
  warmInferenceAdmissionSnapshot,
}));

mock.module("../../utils/logger", () => ({
  logger: { debug: () => {}, warn: () => {}, error: () => {}, info: () => {} },
}));

const { resolveSharedAgent, resetSharedAgentScopeMemoryCacheForTests, seedSharedAgentScopeCache } =
  await import("./resolve-shared-agent");
const { personalSharedAgentId } = await import("./personal-shared-agent");
const { CacheTTL, CacheKeys } = await import("../../cache/keys");

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
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "agent-1",
    organization_id: "org-1",
    execution_tier: "shared",
    status: "running",
    bridge_url: null,
    agent_name: "Shared Agent",
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    claimed_at: null,
    pool_ready_at: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    last_billed_at: null,
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetSharedAgentScopeMemoryCacheForTests();
  requireUserOrApiKeyWithOrg.mockClear();
  requireUserOrApiKeyWithOrgLookup.mockReset();
  requireUserOrApiKeyWithOrgLookup.mockImplementation(
    async <T>(_: unknown, lookup: (organizationId: string) => Promise<T>) => ({
      user: { organization_id: "org-1", steward_id: "steward-user-1" },
      orgLookupResult: await lookup("org-1"),
    }),
  );
  findByIdAndOrg.mockClear();
  findByIdAndOrg.mockResolvedValue(null);
  cacheGet.mockClear();
  cacheSet.mockClear();
  cacheDel.mockClear();
  cacheGetOrSet.mockClear();
  inFlight.clear();
  validateApiKey.mockClear();
  warmInferenceAdmissionSnapshot.mockClear();
  cacheStore.clear();
  sessionScopeHashPrefix.mockClear();
  revalidateSessionScope.mockClear();
  isStagingSessionScopeCandidate.mockClear();
  scopeHashPrefixBehavior = async () => "keyhashpref0000";
  sessionHashPrefixBehavior = async () => null;
  sessionRevalidateBehavior = async () => true;
  stagingSessionCandidateBehavior = false;
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

  test("resolves the account's namespaced personal identity without a sandbox row", async () => {
    const agentId = personalSharedAgentId({
      userId: "user-1",
      organizationId: "org-1",
    });

    await expect(resolveSharedAgent(contextWithAgentId(agentId) as never)).resolves.toMatchObject({
      agentId,
      orgId: "org-1",
      agentName: "Eliza",
      agentKind: "personal",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(findByIdAndOrg).not.toHaveBeenCalled();
  });

  test("hides another account's personal identity as not found", async () => {
    const otherAccountId = personalSharedAgentId({
      userId: "user-2",
      organizationId: "org-2",
    });

    await expect(resolveSharedAgent(contextWithAgentId(otherAccountId) as never)).resolves.toEqual({
      error: "Agent not found",
      status: 404,
    });
    expect(findByIdAndOrg).not.toHaveBeenCalled();
  });

  test("cache-only miss warms in waitUntil and performs no inline DB hydration", async () => {
    findByIdAndOrg.mockResolvedValue(agent());
    const waited: Promise<unknown>[] = [];
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toEqual({
      error: "Agent authorization cache is warming. Retry shortly.",
      status: 503,
      code: "agent_cache_warming",
      retryAfterSeconds: 1,
    });
    expect(waited).toHaveLength(1);
    await waited[0];
    expect(findByIdAndOrg).toHaveBeenCalledTimes(1);
    cacheStore.set(
      CacheKeys.apiKey.validation(
        createHash("sha256").update("eliza_testkey").digest("hex").substring(0, 16),
      ),
      { is_active: true, organization_id: "org-1", expires_at: null },
    );

    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    expect(findByIdAndOrg).toHaveBeenCalledTimes(1);
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  test("warm isolate performs only the credential-validity cache read", async () => {
    const scopeKey = CacheKeys.sharedAgentScope.resolve("keyhashpref0000", "agent-1");
    const validationKey = CacheKeys.apiKey.validation(
      createHash("sha256").update("eliza_testkey").digest("hex").substring(0, 16),
    );
    cacheStore.set(scopeKey, {
      orgId: "org-1",
      agent: agent(),
      firstWrittenAtMs: Date.now(),
    });
    cacheStore.set(validationKey, {
      is_active: true,
      organization_id: "org-1",
      expires_at: null,
    });
    const waited: Promise<unknown>[] = [];
    const options = {
      cacheOnly: true,
      executionCtx: { waitUntil: (promise: Promise<unknown>) => waited.push(promise) },
    };

    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, options),
    ).resolves.toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    await Promise.all(waited.splice(0));
    cacheGet.mockClear();

    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, options),
    ).resolves.toMatchObject({ agentId: "agent-1", orgId: "org-1" });

    expect(cacheGet).toHaveBeenCalledTimes(1);
    expect(cacheGet).toHaveBeenCalledWith(validationKey);
    expect(findByIdAndOrg).not.toHaveBeenCalled();
  });

  test("cache-only does not freeze a non-shared decision after the agent becomes shared", async () => {
    findByIdAndOrg.mockResolvedValue(
      agent({
        execution_tier: "dedicated-lazy",
        status: "running",
        bridge_url: "https://agent.example.test",
      }),
    );
    const waited: Promise<unknown>[] = [];
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toMatchObject({ status: 503 });
    await Promise.all(waited);

    const scopeKey = CacheKeys.sharedAgentScope.resolve("keyhashpref0000", "agent-1");
    expect(cacheStore.get(scopeKey)).toEqual({
      requiresAuthoritativeResolution: true,
    });
    findByIdAndOrg.mockResolvedValue(agent());
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toMatchObject({ agentId: "agent-1", orgId: "org-1" });
  });

  test("cache-only returns a permanent non-shared decision on the retry", async () => {
    findByIdAndOrg.mockResolvedValue(
      agent({
        execution_tier: "dedicated-lazy",
        status: "running",
        bridge_url: "https://agent.example.test",
      }),
    );
    const waited: Promise<unknown>[] = [];
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toMatchObject({ status: 503 });
    await Promise.all(waited);

    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toEqual({
      // The refusal is TAGGED, not merely worded. The bridge route dispatches a
      // dedicated agent to its sandbox on this field; when the distinction lived
      // only in the message, #17076 read it as a client verdict and every
      // dedicated agent 404'd for two weeks (#18062). toEqual keeps this exact —
      // a dropped tag fails here rather than silently reaching production.
      error: "Not a shared-runtime agent",
      status: 404,
      refusal: "dedicated-agent",
    });
  });

  test("cache-only converges for a provisioning Dedicated agent: retry is refused authoritatively", async () => {
    findByIdAndOrg.mockResolvedValue(
      agent({ execution_tier: "dedicated-lazy", status: "provisioning" }),
    );
    const waited: Promise<unknown>[] = [];
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toMatchObject({ status: 503 });
    await Promise.all(waited);
    cacheStore.set(
      CacheKeys.apiKey.validation(
        createHash("sha256").update("eliza_testkey").digest("hex").substring(0, 16),
      ),
      { is_active: true, organization_id: "org-1", expires_at: null },
    );

    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toEqual({
      error: "Not a shared-runtime agent",
      status: 404,
      refusal: "dedicated-agent",
    });
  });

  test("cache-only does not freeze a rejected credential after it becomes valid", async () => {
    const { AuthenticationError } = await import("../../api/cloud-worker-errors");
    requireUserOrApiKeyWithOrgLookup.mockImplementation(async () => {
      throw AuthenticationError("Invalid or expired API key");
    });
    const waited: Promise<unknown>[] = [];
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toMatchObject({ status: 503 });
    await Promise.all(waited);

    const scopeKey = CacheKeys.sharedAgentScope.resolve("keyhashpref0000", "agent-1");
    expect(cacheStore.get(scopeKey)).toEqual({
      requiresAuthoritativeResolution: true,
    });
    requireUserOrApiKeyWithOrgLookup.mockImplementation(
      async <T>(_: unknown, lookup: (organizationId: string) => Promise<T>) => ({
        user: { organization_id: "org-1", steward_id: "steward-user-1" },
        orgLookupResult: await lookup("org-1"),
      }),
    );
    findByIdAndOrg.mockResolvedValue(agent());
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toMatchObject({ agentId: "agent-1", orgId: "org-1" });
  });

  test("cache-only returns a permanent credential denial on the retry", async () => {
    const { AuthenticationError } = await import("../../api/cloud-worker-errors");
    requireUserOrApiKeyWithOrgLookup.mockImplementation(async () => {
      throw AuthenticationError("Invalid or expired API key");
    });
    const waited: Promise<unknown>[] = [];
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toMatchObject({ status: 503 });
    await Promise.all(waited);

    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toEqual({
      error: "Invalid or expired API key",
      status: 401,
    });
  });

  test("rejects dedicated agents in every lifecycle state", async () => {
    for (const [status, bridgeUrl] of [
      ["pending", null],
      ["provisioning", null],
      ["running", "https://agent.example.test"],
      ["stopped", "https://agent.example.test"],
    ] as const) {
      findByIdAndOrg.mockResolvedValue(
        agent({
          execution_tier: "dedicated-lazy",
          status,
          bridge_url: bridgeUrl,
        }),
      );

      await expect(resolveSharedAgent(apiKeyContext("agent-1") as never)).resolves.toEqual({
        error: "Not a shared-runtime agent",
        status: 404,
        refusal: "dedicated-agent",
      });
    }
    expect(cacheSet).not.toHaveBeenCalled();
  });

  test("rejects an unknown future tier during pending and provisioning", async () => {
    for (const status of ["pending", "provisioning"]) {
      findByIdAndOrg.mockResolvedValue(
        agent({
          execution_tier: "future-tier",
          status,
          bridge_url: null,
        }),
      );

      await expect(resolveSharedAgent(apiKeyContext("agent-1") as never)).resolves.toEqual({
        error: "Not a shared-runtime agent",
        status: 404,
        refusal: "dedicated-agent",
      });
    }
    expect(cacheSet).not.toHaveBeenCalled();
  });

  test("returns 404 when no org-scoped agent exists", async () => {
    await expect(resolveSharedAgent(apiKeyContext("agent-missing") as never)).resolves.toEqual({
      error: "Agent not found",
      status: 404,
    });
  });

  test("cache-only rejects unsupported credential identity without repository work", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => null;
    const background: Promise<unknown>[] = [];

    await expect(
      resolveSharedAgent(contextWithAgentId("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).resolves.toEqual({
      error: "A supported API key or session credential is required.",
      status: 401,
    });
    expect(background).toHaveLength(0);
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheGetOrSet).not.toHaveBeenCalled();
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
  });

  test("cache-only rejects a missing Worker lifetime without hydration", async () => {
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
      }),
    ).resolves.toEqual({
      error: "Agent authorization cache context is unavailable. Retry shortly.",
      status: 503,
    });
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheGetOrSet).not.toHaveBeenCalled();
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
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

  test("a provisioning Dedicated agent never enters the Shared scope cache", async () => {
    findByIdAndOrg.mockResolvedValue(
      agent({ execution_tier: "dedicated-lazy", status: "provisioning" }),
    );

    await expect(resolveSharedAgent(apiKeyContext("agent-1") as never)).resolves.toEqual({
      error: "Not a shared-runtime agent",
      status: 404,
      refusal: "dedicated-agent",
    });
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

    cacheStore.set(
      CacheKeys.apiKey.validation(
        createHash("sha256").update("eliza_testkey").digest("hex").substring(0, 16),
      ),
      { is_active: true, organization_id: "org-1", expires_at: null },
    );
    const background: Promise<unknown>[] = [];
    // Second hit within the cap: served from cache AND refreshes the TTL under
    // the Worker lifetime contract.
    const result = await resolveSharedAgent(apiKeyContext("agent-1") as never, {
      cacheOnly: true,
      executionCtx: { waitUntil: (promise) => background.push(promise) },
    });
    expect(result).toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    // No cold DB waves on the hit.
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    // The hit re-wrote the entry with the resolve TTL (sliding refresh).
    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [, refreshedValue, ttlSeconds] = cacheSet.mock.calls[0];
    expect(ttlSeconds).toBe(CacheTTL.sharedAgentScope.resolve);
    expect(background).toHaveLength(1);
    await Promise.all(background);
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

  // A session HIT additionally consults the lifecycle-invalidated
  // `user:steward:<id>` entry (revalidateSessionUserState). In production the
  // authoritative hydration warms it via usersService.getByStewardId; the mock
  // gate does not, so tests seed it the same way the real chain would.
  function seedSessionUserState(overrides: Record<string, unknown> = {}) {
    cacheStore.set(CacheKeys.user.byStewardId("steward-user-1"), {
      is_active: true,
      organization_id: "org-1",
      organization: { is_active: true },
      ...overrides,
    });
  }

  test("first cold session hit runs the full gate and caches with the steward user id", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    seedSessionUserState();
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
    seedSessionUserState();
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
    expect(revalidateSessionScope.mock.calls[0][2]).toBe("org-1");
  });

  test("a QA session cache hit uses primary-bound revalidation instead of a Steward user cache", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "qa-sesshash00000";
    stagingSessionCandidateBehavior = true;
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();
    findByIdAndOrg.mockClear();
    revalidateSessionScope.mockClear();
    // No generic user:steward cache is seeded: the QA verifier itself owns the
    // primary user/org check and must not depend on that rollback-era cache.
    const result = await resolveSharedAgent(contextWithAgentId("agent-1") as never);

    expect(result).toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(revalidateSessionScope).toHaveBeenCalledWith(
      expect.anything(),
      "steward-user-1",
      "org-1",
    );
  });

  test("a session hit whose token no longer verifies falls back to the full gate", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    seedSessionUserState();
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();

    // Token now invalid / re-issued for a different user.
    sessionRevalidateBehavior = async () => false;
    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    // Not served from cache -> authoritative gate re-ran.
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
  });

  test("a session hit after the user's lifecycle entry is evicted (ban/deactivate) is NOT served from cache", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    seedSessionUserState();
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();

    // Ban/deactivate: usersService.invalidateCache deletes user:steward:<id>.
    // The scope entry is still warm, but the hit must fail closed into the
    // authoritative gate instead of riding the sliding-refresh cap.
    cacheStore.delete(CacheKeys.user.byStewardId("steward-user-1"));
    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
  });

  test("a session hit for a deactivated user is NOT served from cache", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    seedSessionUserState();
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();

    seedSessionUserState({ is_active: false });
    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
  });

  test("a session hit whose user moved to a different org is NOT served the cached agent", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    seedSessionUserState();
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();

    seedSessionUserState({ organization_id: "org-2" });
    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    expect(requireUserOrApiKeyWithOrgLookup).toHaveBeenCalledTimes(1);
  });

  test("a session hit whose user's organization is deactivated is NOT served from cache", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    seedSessionUserState();
    findByIdAndOrg.mockResolvedValue(agent());

    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
    requireUserOrApiKeyWithOrgLookup.mockClear();

    seedSessionUserState({ organization: { is_active: false } });
    await resolveSharedAgent(contextWithAgentId("agent-1") as never);
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

  // REGRESSION (CONVERSATIONS-500-2026-07-22): the real cache client
  // JSON-serializes on write and JSON-parses on read, so a cached agent row's
  // `timestamp` columns (Drizzle `Date`s on a live DB hydration) come back as
  // ISO STRINGS on a cache HIT. The shared-agent conversations route calls
  // `agent.created_at.toISOString()`, which throws on a string and 500s the
  // read on EVERY cache hit (the observed "first call 200, then 20/20 = 500").
  // The module-level in-memory cache double stores by REFERENCE, which hid this
  // for a year; these tests seed the cache with a JSON-round-tripped entry
  // (exactly what prod holds) and assert resolveSharedAgent restores the Date
  // contract before returning.
  describe("cache-hit Date rehydration", () => {
    const CREATED = new Date("2026-06-18T12:34:56.000Z");

    // Reproduce what the real cache stores: the object AFTER a JSON round-trip.
    function jsonRoundTrip<T>(value: T): T {
      return JSON.parse(JSON.stringify(value)) as T;
    }

    function seedCacheHit(agentOverrides: Record<string, unknown> = {}) {
      const key = CacheKeys.sharedAgentScope.resolve("keyhashpref0000", "agent-1");
      const liveEntry = {
        orgId: "org-1",
        agent: agent({ created_at: CREATED, updated_at: CREATED, ...agentOverrides }),
        firstWrittenAtMs: Date.now(),
      };
      // Store the DESERIALIZED shape a real cache.get would return.
      cacheStore.set(key, jsonRoundTrip(liveEntry));
    }

    test("a JSON-round-tripped cache hit carries created_at as a string (bug precondition)", () => {
      const key = CacheKeys.sharedAgentScope.resolve("keyhashpref0000", "agent-1");
      seedCacheHit();
      const stored = cacheStore.get(key) as { agent: { created_at: unknown } };
      // Precondition the fix must survive: the raw cached value is a string,
      // NOT a Date, so a naive passthrough would 500 the route.
      expect(typeof stored.agent.created_at).toBe("string");
      expect(stored.agent.created_at instanceof Date).toBe(false);
    });

    test("resolveSharedAgent restores created_at to a Date on a cache hit so .toISOString() works", async () => {
      seedCacheHit();

      const result = await resolveSharedAgent(apiKeyContext("agent-1") as never);
      expect("agent" in result).toBe(true);
      if (!("agent" in result)) throw new Error("expected a resolved agent");

      // The fix: the agent handed to route consumers has Date timestamps again.
      expect(result.agent.created_at instanceof Date).toBe(true);
      // The exact call the conversations route makes must not throw.
      expect(() => (result.agent.created_at as Date).toISOString()).not.toThrow();
      expect((result.agent.created_at as Date).toISOString()).toBe(CREATED.toISOString());
      // Served from cache -> the cold authoritative gate did NOT run.
      expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    });

    test("updated_at and other timestamp fields are rehydrated too", async () => {
      seedCacheHit();
      const result = await resolveSharedAgent(apiKeyContext("agent-1") as never);
      if (!("agent" in result)) throw new Error("expected a resolved agent");
      expect(result.agent.updated_at instanceof Date).toBe(true);
    });

    test("a null/absent timestamp field is left untouched (no fabricated Date)", async () => {
      // deleted_at is nullable; a cache hit must not fabricate a Date for it.
      seedCacheHit({ deleted_at: null });
      const result = await resolveSharedAgent(apiKeyContext("agent-1") as never);
      if (!("agent" in result)) throw new Error("expected a resolved agent");
      expect(result.agent.deleted_at).toBeNull();
    });

    test("an invalid cached timestamp fails observably", async () => {
      seedCacheHit({ last_heartbeat_at: "not-a-timestamp" });

      const error = await resolveSharedAgent(apiKeyContext("agent-1") as never).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("name", "ElizaError");
      expect(error).toHaveProperty("code", "INVALID_CACHED_AGENT_TIMESTAMP");
      expect(error).toHaveProperty("context", {
        field: "last_heartbeat_at",
        value: "not-a-timestamp",
      });
    });
  });
});

describe("seedSharedAgentScopeCache (fresh-create -> immediate-send)", () => {
  const validationKey = () =>
    CacheKeys.apiKey.validation(
      createHash("sha256").update("eliza_testkey").digest("hex").substring(0, 16),
    );

  test("API-key path: a seeded fresh create takes an immediate cache-only send without 503 or DB hydration", async () => {
    // The create request's own auth already validated the key (and cached it);
    // the seeder writes the scope entry that same request derives.
    cacheStore.set(validationKey(), {
      is_active: true,
      organization_id: "org-1",
      expires_at: null,
    });
    await seedSharedAgentScopeCache(apiKeyContext("agent-1") as never, agent() as never);

    // The immediate send may land on a DIFFERENT isolate: only the distributed
    // entry may carry the hit.
    resetSharedAgentScopeMemoryCacheForTests();

    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: () => undefined },
      }),
    ).resolves.toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
  });

  test("session path: the seeded entry carries the steward user id and serves the immediate send", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => "sesshashpref0000";
    // The create request's auth hydrated the lifecycle-invalidated user entry.
    cacheStore.set(CacheKeys.user.byStewardId("steward-user-1"), {
      is_active: true,
      organization_id: "org-1",
      organization: { is_active: true },
    });
    await seedSharedAgentScopeCache(
      contextWithAgentId("agent-1") as never,
      agent() as never,
      "steward-user-1",
    );
    const seeded = cacheStore.get(
      CacheKeys.sharedAgentScope.resolve("s:sesshashpref0000", "agent-1"),
    ) as { stewardUserId?: string };
    expect(seeded.stewardUserId).toBe("steward-user-1");

    resetSharedAgentScopeMemoryCacheForTests();

    await expect(
      resolveSharedAgent(contextWithAgentId("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: () => undefined },
      }),
    ).resolves.toMatchObject({ agentId: "agent-1", orgId: "org-1" });
    expect(revalidateSessionScope).toHaveBeenCalledWith(
      expect.anything(),
      "steward-user-1",
      "org-1",
    );
    expect(findByIdAndOrg).not.toHaveBeenCalled();
  });

  test("seeding does NOT bypass the per-request credential gate: a re-scoped key falls back to warming", async () => {
    await seedSharedAgentScopeCache(apiKeyContext("agent-1") as never, agent() as never);
    resetSharedAgentScopeMemoryCacheForTests();
    // The presented key now validates to a DIFFERENT org (revoke/re-scope).
    cacheStore.set(validationKey(), {
      is_active: true,
      organization_id: "org-2",
      expires_at: null,
    });

    const waited: Promise<unknown>[] = [];
    await expect(
      resolveSharedAgent(apiKeyContext("agent-1") as never, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => waited.push(promise) },
      }),
    ).resolves.toMatchObject({ status: 503 });
    await Promise.all(waited);
  });

  test("a request with no supported credential seeds nothing", async () => {
    scopeHashPrefixBehavior = async () => null;
    sessionHashPrefixBehavior = async () => null;
    await seedSharedAgentScopeCache(contextWithAgentId("agent-1") as never, agent() as never);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  test("a non-shared agent is never seeded", async () => {
    await seedSharedAgentScopeCache(
      apiKeyContext("agent-1") as never,
      agent({ execution_tier: "dedicated-lazy" }) as never,
    );
    expect(cacheSet).not.toHaveBeenCalled();
  });
});
