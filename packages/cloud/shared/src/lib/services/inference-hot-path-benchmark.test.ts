/**
 * Hot-path benchmark / cost assertion for the inference single-cache auth (#9899).
 *
 * The headline claim of the design (packages/cloud/api/docs/inference-hot-path.md)
 * is that a WARM, fully-authorized API-key request resolves auth + org +
 * moderation with EXACTLY ONE cache read and ZERO authoritative-chain work
 * (no auth DB read, no moderation Postgres read, no reserve write on resolve).
 *
 * This test instruments the real CacheClient (MOCK_REDIS in-memory) and the
 * mocked auth/moderation seams to assert those exact counts, so a regression
 * that reintroduces a DB read into the hot path fails loudly here.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";
// This benchmark measures the STAGED cache-on auth path. The flag is
// default-off in every checked-in environment (wrangler.toml) until #17093
// lands a strongly consistent revocation boundary; enabling it here exercises
// the gated single-cache-read contract without changing any shipped default.
const originalAuthCacheFlag = process.env.INFERENCE_AUTH_CACHE_ENABLED;
process.env.INFERENCE_AUTH_CACHE_ENABLED = "true";

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

let authChainCalls = 0;
let moderationCalls = 0;
let usageCalls = 0;
let admissionLoadCalls = 0;
let appScopeCalls = 0;

// IAC v2 (#17805) co-locates the admission snapshot + app-key scope with the
// cached identity: both authoritative loads may run ONLY while warming a cold
// miss, never on the warm path. Counted here so a regression that moves either
// read back onto the hot path fails this benchmark.
const ADMISSION = {
  balance: { balanceUsd: 100, balanceAt: 1, balanceRevision: "1" },
  rateLimits: {
    completionsRpm: 60,
    embeddingsRpm: 100,
    standardRpm: 30,
    strictRpm: 5,
  },
};

mock.module("./inference-admission-snapshot", () => ({
  loadInferenceAdmissionSnapshot: async () => {
    admissionLoadCalls++;
    return ADMISSION;
  },
}));
mock.module("./inference-app-key-scope", () => ({
  loadInferenceAppKeyScope: async () => {
    appScopeCalls++;
    return null;
  },
}));

mock.module("./inference-api-key-auth", () => ({
  requireInferenceApiKeyWithOrg: async () => {
    authChainCalls++;
    return {
      user: { id: "user-bench", organization_id: "org-bench" },
      apiKey: { id: "key-bench" },
    };
  },
}));
mock.module("./admin", () => ({
  adminService: {
    shouldBlockUser: async () => {
      moderationCalls++;
      return false;
    },
  },
}));
mock.module("./content-moderation", () => ({
  contentModerationService: {
    shouldBlockUser: async () => {
      moderationCalls++;
      return false;
    },
  },
}));
mock.module("./api-keys", () => ({
  apiKeysService: {
    incrementUsageDebounced: async () => {
      usageCalls++;
    },
  },
}));
const { resolveInferenceAuthContext } = await import("./inference-auth-context");
const { hashApiKey, invalidateInferenceAuthContextByKeyHash } = await import(
  "./inference-auth-cache"
);
const { cache } = await import("../cache/client");

const KEY = "eliza_bench_key";
function req(): Request {
  return new Request("https://api/api/v1/chat/completions", {
    method: "POST",
    headers: { "X-API-Key": KEY },
  });
}

beforeEach(async () => {
  authChainCalls = 0;
  moderationCalls = 0;
  usageCalls = 0;
  admissionLoadCalls = 0;
  appScopeCalls = 0;
  await invalidateInferenceAuthContextByKeyHash(hashApiKey(KEY));
});

afterEach(() => {
  mock.restore();
});

// Cloud-shared test files can share one bun process; leaving the staged flag
// enabled would silently flip later files onto the cache-on path.
afterAll(() => {
  if (originalAuthCacheFlag === undefined) {
    delete process.env.INFERENCE_AUTH_CACHE_ENABLED;
  } else {
    process.env.INFERENCE_AUTH_CACHE_ENABLED = originalAuthCacheFlag;
  }
});

describe("inference hot-path benchmark", () => {
  test("cold miss pays the authoritative chain exactly once, then caches", async () => {
    const cold = await resolveInferenceAuthContext(req());
    expect(cold.kind).toBe("authorized");
    expect(authChainCalls).toBe(1); // one auth chain
    expect(moderationCalls).toBe(1); // one moderation read
    expect(admissionLoadCalls).toBe(1); // one admission projection load (IAC v2)
    expect(appScopeCalls).toBe(1); // one app-key scope load (IAC v2)
  });

  test("WARM hit = exactly 1 cache read, 0 writes, 0 auth, 0 moderation", async () => {
    await resolveInferenceAuthContext(req()); // populate (cold)

    const getSpy = spyOn(cache, "getWithOutcome");
    const setSpy = spyOn(cache, "setWithOutcome");
    const delSpy = spyOn(cache, "del");
    authChainCalls = 0;
    moderationCalls = 0;
    admissionLoadCalls = 0;
    appScopeCalls = 0;

    const warm = await resolveInferenceAuthContext(req());

    expect(warm.kind).toBe("authorized");
    if (warm.kind === "authorized") expect(warm.source).toBe("cache");
    // THE benchmark assertion: one cache read, nothing else touched.
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(0);
    expect(delSpy).toHaveBeenCalledTimes(0);
    expect(authChainCalls).toBe(0); // zero auth DB work
    expect(moderationCalls).toBe(0); // zero moderation DB work
    expect(admissionLoadCalls).toBe(0); // admission rides in the single cache read (IAC v2)
    expect(appScopeCalls).toBe(0); // app scope rides in the single cache read (IAC v2)
    expect(usageCalls).toBe(1); // usage tracking is fire-and-forget, not a hot read

    getSpy.mockRestore();
    setSpy.mockRestore();
    delSpy.mockRestore();
  });

  test("N warm hits stay O(1) cache reads each (no per-request DB growth)", async () => {
    await resolveInferenceAuthContext(req()); // populate

    const getSpy = spyOn(cache, "getWithOutcome");
    authChainCalls = 0;
    moderationCalls = 0;
    admissionLoadCalls = 0;
    appScopeCalls = 0;

    const N = 25;
    for (let i = 0; i < N; i++) await resolveInferenceAuthContext(req());

    expect(getSpy).toHaveBeenCalledTimes(N); // exactly one read per request
    expect(authChainCalls).toBe(0);
    expect(moderationCalls).toBe(0);
    expect(admissionLoadCalls).toBe(0);
    expect(appScopeCalls).toBe(0);

    getSpy.mockRestore();
  });
});
