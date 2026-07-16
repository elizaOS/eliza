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

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

let authChainCalls = 0;
let moderationCalls = 0;
let usageCalls = 0;

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
  await invalidateInferenceAuthContextByKeyHash(hashApiKey(KEY));
});

afterEach(() => {
  mock.restore();
});

describe("inference hot-path benchmark", () => {
  test("cold miss pays the authoritative chain exactly once, then caches", async () => {
    const cold = await resolveInferenceAuthContext(req());
    expect(cold.kind).toBe("authorized");
    expect(authChainCalls).toBe(1); // one auth chain
    expect(moderationCalls).toBe(1); // one moderation read
  });

  test("WARM hit = exactly 1 cache read, 0 writes, 0 auth, 0 moderation", async () => {
    await resolveInferenceAuthContext(req()); // populate (cold)

    const getSpy = spyOn(cache, "getWithOutcome");
    const setSpy = spyOn(cache, "setWithOutcome");
    const delSpy = spyOn(cache, "del");
    authChainCalls = 0;
    moderationCalls = 0;

    const warm = await resolveInferenceAuthContext(req());

    expect(warm.kind).toBe("authorized");
    if (warm.kind === "authorized") expect(warm.source).toBe("cache");
    // THE benchmark assertion: one cache read, nothing else touched.
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(0);
    expect(delSpy).toHaveBeenCalledTimes(0);
    expect(authChainCalls).toBe(0); // zero auth DB work
    expect(moderationCalls).toBe(0); // zero moderation DB work
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

    const N = 25;
    for (let i = 0; i < N; i++) await resolveInferenceAuthContext(req());

    expect(getSpy).toHaveBeenCalledTimes(N); // exactly one read per request
    expect(authChainCalls).toBe(0);
    expect(moderationCalls).toBe(0);

    getSpy.mockRestore();
  });
});
