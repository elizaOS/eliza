/**
 * #9899 regression: the optimistic billing path must NEVER forward a request on
 * an un-recorded charge when the cache backstop is unavailable (the "free-forever
 * on cache failure" hole). With the cache down, `isOptimisticBackstopAvailable()`
 * is false and `writePendingInferenceCharge()` reports false — so the route falls
 * back to the synchronous reserve instead of serving free inference.
 *
 * Mocks the cache client to emulate an unavailable backend (circuit open /
 * disabled): isAvailable() === false and setIfNotExists THROWS, exactly as the
 * real CacheClient does when getRedisClient() returns null.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../cache/client", () => ({
  cache: {
    isAvailable: () => false,
    async setIfNotExists() {
      throw new Error("Cache unavailable for atomic set-if-not-exists");
    },
    async set() {
      /* swallowed like the real client when unavailable */
    },
    async get() {
      return null;
    },
    async del() {},
    async getAndDelete() {
      return null;
    },
    async scanByPrefix() {
      return [];
    },
  },
}));

// Credits/api-keys are unused on these paths but mocked so the import graph is clean.
mock.module("./credits", () => ({
  creditsService: { deductCredits: async () => ({ success: true, newBalance: 0 }) },
}));
mock.module("./api-keys", () => ({
  apiKeysService: { invalidateInferenceContextForUser: async () => {} },
}));

const { isOptimisticBackstopAvailable, writePendingInferenceCharge } = await import(
  "./inference-billing-fast-path"
);

afterEach(() => {
  mock.restore();
});

describe("optimistic billing with an unavailable cache backstop", () => {
  test("isOptimisticBackstopAvailable() is false (forces the synchronous reserve)", () => {
    expect(isOptimisticBackstopAvailable()).toBe(false);
  });

  test("writePendingInferenceCharge() reports false instead of silently no-op'ing", async () => {
    const persisted = await writePendingInferenceCharge(
      {
        requestId: "req-cachedown",
        organizationId: "org-cachedown",
        userId: "user-cachedown",
        apiKeyId: "key-cachedown",
        model: "llama-3.3-70b",
        provider: "cerebras",
        billingSource: "org",
        estimatedCostUsd: 0.01,
      },
      Date.now(),
    );
    // false -> the route must NOT take the optimistic path; it reserves instead.
    expect(persisted).toBe(false);
  });
});
