/**
 * Verifies shared-runtime admission policy uses one combined remote cache read
 * and hydrates authoritative balance/tier state only under the Worker lifetime.
 */

import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { CacheWriteOutcome } from "../cache/client";

const snapshot = {
  authority: {
    generation: "4",
    source: "subscription" as const,
    sourceSubscriptionId: "subscription-1",
    sourceRevision: "3",
    projectionRevision: "2",
    catalogVersion: "catalog-1",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: "2099-01-01T00:00:00.000Z",
  },
  subscriptionFunded: true,
  balance: { balanceUsd: 12, balanceAt: 1, balanceRevision: "7" },
  rateLimits: {
    completionsRpm: 120,
    embeddingsRpm: 80,
    standardRpm: 60,
    strictRpm: 20,
  },
};
let cached: typeof snapshot | null = null;
const cacheGet = mock(async () => cached);
const cacheSet = mock(async (_key: string, value: typeof snapshot): Promise<CacheWriteOutcome> => {
  cached = value;
  return { kind: "written" as const, backend: "memory" as const };
});
const cacheClientActualModule = await import("../cache/client");

mock.module("../cache/client", () => ({
  ...cacheClientActualModule,
  cache: {
    get: cacheGet,
    setWithOutcome: cacheSet,
    delConfirmed: async () => true,
    delPatternConfirmed: async () => true,
  },
}));

const readOrganizationQuotaPolicy = mock(async () => ({
  authority: snapshot.authority,
  subscriptionFunded: snapshot.subscriptionFunded,
  observedAt: new Date(snapshot.balance.balanceAt).toISOString(),
  balance: { status: "available" as const, value: { balanceUsd: 12, revision: "7" } },
  tier: { status: "available" as const, value: { ...snapshot.rateLimits, tierName: "pro" } },
}));
mock.module("./organization-quota-policy", () => ({
  readOrganizationQuotaPolicy,
  requireOrganizationRateTier: (policy: Awaited<ReturnType<typeof readOrganizationQuotaPolicy>>) =>
    policy.tier.value,
  requireOrganizationPolicyBalance: (
    policy: Awaited<ReturnType<typeof readOrganizationQuotaPolicy>>,
  ) => policy.balance.value,
}));
mock.module("./organization-policy-admission", () => ({
  withOrganizationPolicyAdmission: async (
    _org: string,
    _expected: unknown,
    operation: (
      policy: Awaited<ReturnType<typeof readOrganizationQuotaPolicy>>,
    ) => Promise<unknown>,
  ) => operation(await readOrganizationQuotaPolicy()),
}));
mock.module("../utils/logger", () => ({
  logger: { warn: () => undefined },
}));

const {
  getInferenceAdmissionSnapshotCacheOnly,
  InferenceAdmissionSnapshotCacheWarmingError,
  resetInferenceAdmissionMemoryCacheForTests,
  warmInferenceAdmissionSnapshot,
} = await import("./inference-admission-snapshot");

beforeEach(() => {
  cached = null;
  cacheGet.mockClear();
  cacheSet.mockClear();
  readOrganizationQuotaPolicy.mockClear();
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
  expect(readOrganizationQuotaPolicy).not.toHaveBeenCalled();
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
  expect(readOrganizationQuotaPolicy).toHaveBeenCalledTimes(1);
  expect(cacheSet).toHaveBeenCalledTimes(1);
});

test("a deadline invalidates the isolate entry without any webhook or generation change", async () => {
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    cached = {
      ...snapshot,
      authority: { ...snapshot.authority, effectiveUntil: new Date(now + 100).toISOString() },
    };
    const executionCtx = { waitUntil: mock((_promise: Promise<unknown>) => undefined) };
    await getInferenceAdmissionSnapshotCacheOnly("org-1", executionCtx);
    clock.mockReturnValue(now + 101);
    const background: Promise<unknown>[] = [];
    await expect(
      getInferenceAdmissionSnapshotCacheOnly("org-1", {
        waitUntil: (promise) => background.push(promise),
      }),
    ).rejects.toBeInstanceOf(InferenceAdmissionSnapshotCacheWarmingError);
    await Promise.all(background);
    expect(cacheGet).toHaveBeenCalledTimes(2);
    expect(readOrganizationQuotaPolicy).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

test("an unacknowledged cache write does not populate a successful local admission entry", async () => {
  cacheSet.mockImplementationOnce(async () => ({ kind: "error", backend: "cloudflare_kv" }));
  await expect(warmInferenceAdmissionSnapshot("org-write-failed")).rejects.toBeInstanceOf(
    InferenceAdmissionSnapshotCacheWarmingError,
  );
  const background: Promise<unknown>[] = [];
  await expect(
    getInferenceAdmissionSnapshotCacheOnly("org-write-failed", {
      waitUntil: (promise) => background.push(promise),
    }),
  ).rejects.toBeInstanceOf(InferenceAdmissionSnapshotCacheWarmingError);
  expect(cacheGet).toHaveBeenCalledTimes(1);
  await Promise.all(background);
  expect(cacheSet).toHaveBeenCalledTimes(2);
});
