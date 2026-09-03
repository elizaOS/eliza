/** Proves outbound standing uses one cache read and asynchronous no-readback projection. */

import { beforeEach, expect, mock, test } from "bun:test";

const cacheRead = mock();
const cacheWrite = mock(async () => ({ kind: "written" as const, backend: "memory" as const }));
const cacheDelete = mock(async () => true);
const cacheDeletePattern = mock(async () => true);
const selectLimit = mock();
const selectBuilder = {
  from: mock(() => selectBuilder),
  leftJoin: mock(() => selectBuilder),
  where: mock(() => selectBuilder),
  limit: selectLimit,
};

mock.module("../cache/client", () => ({
  cache: {
    getWithOutcome: cacheRead,
    setWithOutcome: cacheWrite,
    delConfirmed: cacheDelete,
    delPatternConfirmed: cacheDeletePattern,
  },
}));

mock.module("../../db/helpers", () => ({
  dbWrite: { select: mock(() => selectBuilder) },
}));

mock.module("../utils/logger", () => ({
  logger: { warn: mock() },
}));

const { resolveOutboundMessageStanding } = await import("./outbound-message-standing");

const activeStandingRow = {
  userId: "user-1",
  userActive: true,
  userDeletedAt: null,
  userLifecycleState: "active",
  userDeletionRequestId: null,
  organizationId: "org-1",
  organizationActive: true,
  organizationLifecycleState: "active",
  organizationLifecycleRevision: 4,
  organizationDeletionRequestId: null,
  moderationStatus: "clean",
  moderationViolations: 0,
} as const;

beforeEach(() => {
  cacheRead.mockReset();
  cacheWrite.mockClear();
  selectLimit.mockReset();
});

test("cached denial explains the reason with exactly one read and no database or write", async () => {
  cacheRead.mockResolvedValueOnce({
    kind: "hit",
    backend: "cloudflare-kv",
    value: {
      v: 1,
      organizationId: "org-1",
      userId: "user-1",
      cachedAt: Date.now(),
      decision: "denied",
      reason: "moderation_blocked",
    },
  });

  await expect(resolveOutboundMessageStanding("org-1", "user-1")).resolves.toEqual({
    allowed: false,
    source: "cache",
    reason: "moderation_blocked",
  });
  expect(cacheRead).toHaveBeenCalledTimes(1);
  expect(selectLimit).not.toHaveBeenCalled();
  expect(cacheWrite).not.toHaveBeenCalled();
});

test("a miss hydrates once and defers one cache write without a readback", async () => {
  cacheRead.mockResolvedValueOnce({ kind: "miss", backend: "cloudflare-kv" });
  selectLimit.mockResolvedValueOnce([activeStandingRow]);
  const deferred: Promise<unknown>[] = [];

  await expect(
    resolveOutboundMessageStanding("org-1", "user-1", {
      defer: (promise) => deferred.push(promise),
    }),
  ).resolves.toEqual({ allowed: true, source: "authoritative" });
  expect(cacheRead).toHaveBeenCalledTimes(1);
  expect(selectLimit).toHaveBeenCalledTimes(1);
  expect(cacheWrite).toHaveBeenCalledTimes(1);
  expect(cacheRead).toHaveBeenCalledTimes(1);
  expect(deferred).toHaveLength(1);
  await Promise.all(deferred);
});

const deniedStandingCases = [
  {
    name: "missing account",
    rows: [],
    reason: "account_missing",
  },
  {
    name: "inactive account lifecycle",
    rows: [{ ...activeStandingRow, userLifecycleState: "suspended" }],
    reason: "account_inactive",
  },
  {
    name: "cross-organization membership",
    rows: [{ ...activeStandingRow, organizationId: "org-2" }],
    reason: "membership_missing",
  },
  {
    name: "inactive organization lifecycle",
    rows: [{ ...activeStandingRow, organizationLifecycleState: "closing" }],
    reason: "organization_inactive",
  },
  {
    name: "banned moderation status",
    rows: [{ ...activeStandingRow, moderationStatus: "banned" }],
    reason: "moderation_blocked",
  },
] as const;

for (const scenario of deniedStandingCases) {
  test(`authoritative standing denies ${scenario.name}`, async () => {
    cacheRead.mockResolvedValueOnce({ kind: "miss", backend: "cloudflare-kv" });
    selectLimit.mockResolvedValueOnce(scenario.rows);
    const deferred: Promise<unknown>[] = [];

    await expect(
      resolveOutboundMessageStanding("org-1", "user-1", {
        defer: (promise) => deferred.push(promise),
      }),
    ).resolves.toEqual({
      allowed: false,
      source: "authoritative",
      reason: scenario.reason,
    });
    expect(cacheRead).toHaveBeenCalledTimes(1);
    expect(selectLimit).toHaveBeenCalledTimes(1);
    expect(cacheWrite).toHaveBeenCalledTimes(1);
    expect(cacheWrite).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ decision: "denied", reason: scenario.reason }),
      expect.any(Number),
      expect.any(Object),
    );
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
  });
}
