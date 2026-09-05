/**
 * Verifies shared-runtime admission policy uses one combined remote cache read
 * and hydrates authoritative balance/tier state only under the Worker lifetime.
 */

import { beforeEach, expect, mock, test } from "bun:test";

const snapshot = {
  subscriptionFunded: true,
  balance: { balanceUsd: 12, balanceAt: 1, balanceRevision: 7 },
  rateLimits: {
    completionsRpm: 120,
    embeddingsRpm: 80,
    standardRpm: 60,
    strictRpm: 20,
  },
};
let cached: typeof snapshot | null = null;
const cacheGet = mock(async () => cached);
const cacheSet = mock(async (_key: string, value: typeof snapshot) => {
  cached = value;
});
mock.module("../cache/client", () => ({
  cache: { get: cacheGet, set: cacheSet },
}));

const getOrganizationBalanceSnapshot = mock(async () => ({
  balanceUsd: 12,
  revision: 7,
}));
mock.module("./credits", () => ({
  creditsService: { getOrganizationBalanceSnapshot },
}));

const findSubscriptionEntitlement = mock(async () => ({ plan_key: "pro" }));
mock.module("../../db/repositories/subscription-entitlements", () => ({
  subscriptionEntitlementsRepository: { find: findSubscriptionEntitlement },
}));

const readOrgTierFromSources = mock(async () => snapshot.rateLimits);
const recalculateOrgTier = mock(async () => {
  throw new Error("inference projection must not hydrate the separate tier cache");
});
mock.module("./org-rate-limits", () => ({
  readOrgTierFromSources,
  recalculateOrgTier,
}));
mock.module("../utils/logger", () => ({
  logger: { warn: () => undefined },
}));

const {
  getInferenceAdmissionSnapshotCacheOnly,
  InferenceAdmissionSnapshotCacheWarmingError,
  resetInferenceAdmissionMemoryCacheForTests,
} = await import("./inference-admission-snapshot");

beforeEach(() => {
  cached = null;
  cacheGet.mockClear();
  cacheSet.mockClear();
  getOrganizationBalanceSnapshot.mockClear();
  findSubscriptionEntitlement.mockClear();
  readOrgTierFromSources.mockClear();
  recalculateOrgTier.mockClear();
  resetInferenceAdmissionMemoryCacheForTests();
});

test("one remote read serves the projection and later isolate hits are local", async () => {
  cached = snapshot;
  const executionCtx = { waitUntil: mock((_promise: Promise<unknown>) => undefined) };

  await expect(getInferenceAdmissionSnapshotCacheOnly("org-1", executionCtx)).resolves.toEqual(
    snapshot,
  );
  await expect(getInferenceAdmissionSnapshotCacheOnly("org-1", executionCtx)).resolves.toEqual(
    snapshot,
  );

  expect(cacheGet).toHaveBeenCalledTimes(1);
  expect(getOrganizationBalanceSnapshot).not.toHaveBeenCalled();
  expect(readOrgTierFromSources).not.toHaveBeenCalled();
  expect(recalculateOrgTier).not.toHaveBeenCalled();
  expect(findSubscriptionEntitlement).not.toHaveBeenCalled();
});

test("a miss registers authoritative hydration and fails closed", async () => {
  const background: Promise<unknown>[] = [];

  await expect(
    getInferenceAdmissionSnapshotCacheOnly("org-1", {
      waitUntil: (promise) => background.push(promise),
    }),
  ).rejects.toBeInstanceOf(InferenceAdmissionSnapshotCacheWarmingError);

  expect(cacheGet).toHaveBeenCalledTimes(1);
  expect(background).toHaveLength(1);
  await background[0];
  expect(getOrganizationBalanceSnapshot).toHaveBeenCalledTimes(1);
  expect(readOrgTierFromSources).toHaveBeenCalledTimes(1);
  expect(recalculateOrgTier).not.toHaveBeenCalled();
  expect(findSubscriptionEntitlement).toHaveBeenCalledTimes(1);
  expect(cacheSet).toHaveBeenCalledTimes(1);
});
