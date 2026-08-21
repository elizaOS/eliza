/**
 * Verifies shared-runtime admission policy uses one combined remote cache read
 * and hydrates authoritative balance/tier state only under the Worker lifetime.
 */

import { beforeEach, expect, mock, test } from "bun:test";

const snapshot = {
  balance: { balanceUsd: 12, balanceAt: 1, balanceRevision: "7" },
  rateLimits: {
    completionsRpm: 120,
    embeddingsRpm: 80,
    standardRpm: 60,
    strictRpm: 20,
    catalogVersion: "v1",
    entitlementVersion: "projection:7",
    manualOverrideVersion: null,
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
  revision: "7",
}));
mock.module("./credits", () => ({
  creditsService: { getOrganizationBalanceSnapshot },
}));

const recalculateOrgTier = mock(async () => snapshot.rateLimits);
mock.module("./org-rate-limits", () => ({
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
  expect(recalculateOrgTier).not.toHaveBeenCalled();
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
  expect(recalculateOrgTier).toHaveBeenCalledTimes(1);
  expect(cacheSet).toHaveBeenCalledTimes(1);
});

test("a stale catalog-version snapshot fails closed and hydrates replacement", async () => {
  cached = {
    ...snapshot,
    rateLimits: { ...snapshot.rateLimits, catalogVersion: "v0" },
  };
  const background: Promise<unknown>[] = [];

  await expect(
    getInferenceAdmissionSnapshotCacheOnly("org-1", {
      waitUntil: (promise) => background.push(promise),
    }),
  ).rejects.toBeInstanceOf(InferenceAdmissionSnapshotCacheWarmingError);

  expect(background).toHaveLength(1);
  await background[0];
  expect(getOrganizationBalanceSnapshot).toHaveBeenCalledTimes(1);
  expect(recalculateOrgTier).toHaveBeenCalledTimes(1);
  expect(cacheSet).toHaveBeenCalledTimes(1);
});
