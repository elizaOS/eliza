/**
 * Unit tests for broker lease lifetime behavior that is awkward to exercise
 * through HTTP without sleeping. A minimal fake AccountPool drives the broker
 * while a deterministic clock advances past the bounded TTL.
 */
import type { LinkedAccountConfig } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import type { AccountPool } from "./account-pool.js";
import { AccountPoolBroker } from "./account-pool-broker.js";

function account(
  overrides: Partial<LinkedAccountConfig> = {},
): LinkedAccountConfig {
  return {
    id: "primary",
    providerId: "anthropic-subscription",
    label: "primary",
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
    ...overrides,
  };
}

describe("AccountPoolBroker TTL", () => {
  it("expires leases and reports them as expired instead of mutating accounts", async () => {
    let now = 1_000;
    const recordCall = vi.fn(async () => {});
    const pool = {
      select: vi.fn(async () => account()),
      recordCall,
      markHealthy: vi.fn(async () => {}),
      markRateLimited: vi.fn(async () => {}),
      markNeedsReauth: vi.fn(async () => {}),
      list: vi.fn(() => [account()]),
    } as unknown as AccountPool;
    const broker = new AccountPoolBroker({
      pool,
      now: () => now,
      leaseTtlMs: 1_000,
      idGenerator: () => "lease-1",
      tokenResolver: async () => ({
        accessToken: "access",
        accessExpiresAt: 10_000,
      }),
    });

    const lease = await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "session",
      strategy: "priority",
    });
    expect(lease?.leaseId).toBe("lease-1");
    now = 2_001;

    await expect(
      broker.report({ leaseId: "lease-1", ok: true, httpStatus: 200 }),
    ).resolves.toEqual({ ok: false, error: "expired_lease" });
    expect(recordCall).not.toHaveBeenCalled();
  });
});

describe("AccountPoolBroker observability", () => {
  it("attributes leases with hashed session keys and updates model from reports", async () => {
    let now = 10_000;
    const pool = {
      select: vi.fn(async () => account({ id: "primary" })),
      recordCall: vi.fn(async () => {}),
      markHealthy: vi.fn(async () => {}),
      markRateLimited: vi.fn(async () => {}),
      markNeedsReauth: vi.fn(async () => {}),
      list: vi.fn(() => [account({ id: "primary" })]),
    } as unknown as AccountPool;
    const broker = new AccountPoolBroker({
      pool,
      now: () => now,
      idGenerator: () => "lease-primary",
      tokenResolver: async () => ({
        accessToken: "access",
        accessExpiresAt: 20_000,
      }),
    });

    const lease = await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "raw-session-key",
      strategy: "least-used",
    });
    expect(lease?.leaseId).toBe("lease-primary");
    now += 5;
    await broker.report({
      leaseId: "lease-primary",
      ok: true,
      httpStatus: 200,
      model: "claude-fable-5",
    });

    const snapshot = broker.snapshot();
    const observed = snapshot.accounts["anthropic-subscription:primary"];
    expect(observed).toMatchObject({
      activeLeaseCount: 1,
      lastLeaseAt: 10_000,
      lastReportedStatus: {
        ok: true,
        category: "ok",
        reason: "ok",
        model: "claude-fable-5",
      },
    });
    expect(observed?.lastLease).toMatchObject({
      leaseId: "lease-primary",
      atMs: 10_000,
      model: "claude-fable-5",
    });
    expect(observed?.lastLease?.sessionKeyHash).toMatch(/^[a-f0-9]{12}$/);
    expect(observed?.lastLease?.sessionKeyHash).not.toContain("raw-session");
    expect(snapshot.providers["anthropic-subscription"]?.lastSelection).toEqual(
      {
        accountId: "primary",
        atMs: 10_000,
        reason: "least-used",
      },
    );
  });

  it("records failover only for a different account within sixty seconds", async () => {
    let now = 1_000;
    let nextAccountId = "a";
    let leaseIndex = 0;
    const pool = {
      select: vi.fn(async () => account({ id: nextAccountId })),
      recordCall: vi.fn(async () => {}),
      markHealthy: vi.fn(async () => {}),
      markRateLimited: vi.fn(async () => {}),
      markNeedsReauth: vi.fn(async () => {}),
      list: vi.fn(() => [account({ id: "a" }), account({ id: "b" })]),
    } as unknown as AccountPool;
    const broker = new AccountPoolBroker({
      pool,
      now: () => now,
      idGenerator: () => `lease-${++leaseIndex}`,
      tokenResolver: async () => ({
        accessToken: "access",
        accessExpiresAt: 100_000,
      }),
    });

    const first = await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "same-session",
    });
    await broker.report({
      leaseId: first?.leaseId ?? "",
      ok: false,
      httpStatus: 429,
      errorCode: "quota exceeded for user@example.com token sk-secret",
      model: "claude-fable-5",
    });
    nextAccountId = "a";
    now += 1_000;
    await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "same-session",
    });
    expect(
      broker.snapshot().providers["anthropic-subscription"]?.recentFailovers,
    ).toEqual([]);

    const recovered = await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "recovered-session",
    });
    await broker.report({
      leaseId: recovered?.leaseId ?? "",
      ok: false,
      httpStatus: 500,
    });
    await broker.report({ leaseId: recovered?.leaseId ?? "", ok: true });
    broker.release({ leaseId: recovered?.leaseId ?? "" });
    nextAccountId = "b";
    now += 1_000;
    await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "recovered-session",
    });
    expect(
      broker.snapshot().providers["anthropic-subscription"]?.recentFailovers,
    ).toEqual([]);

    const second = await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "same-session-2",
    });
    await broker.report({
      leaseId: second?.leaseId ?? "",
      ok: false,
      httpStatus: 500,
      errorCode: "upstream_timeout",
    });
    nextAccountId = "b";
    now += 60_001;
    await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "same-session-2",
    });
    expect(
      broker.snapshot().providers["anthropic-subscription"]?.recentFailovers,
    ).toEqual([]);

    nextAccountId = "a";
    const third = await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "same-session-3",
    });
    await broker.report({
      leaseId: third?.leaseId ?? "",
      ok: false,
      httpStatus: 401,
      errorCode: "refresh token revoked for user@example.com",
    });
    nextAccountId = "b";
    now += 59_999;
    await broker.lease({
      providerId: "anthropic-subscription",
      sessionKey: "same-session-3",
    });

    const failovers =
      broker.snapshot().providers["anthropic-subscription"]?.recentFailovers ??
      [];
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({
      fromAccountId: "a",
      toAccountId: "b",
      cause: { category: "auth", reason: "http_401" },
    });
    expect(JSON.stringify(failovers[0])).not.toContain("user@example.com");
    expect(JSON.stringify(failovers[0])).not.toContain("sk-secret");
  });

  it("caps recent failovers at ten per provider", async () => {
    let now = 1_000;
    let nextAccountId = "a";
    let leaseIndex = 0;
    const pool = {
      select: vi.fn(async () => account({ id: nextAccountId })),
      recordCall: vi.fn(async () => {}),
      markHealthy: vi.fn(async () => {}),
      markRateLimited: vi.fn(async () => {}),
      markNeedsReauth: vi.fn(async () => {}),
      list: vi.fn(() => [account({ id: "a" }), account({ id: "b" })]),
    } as unknown as AccountPool;
    const broker = new AccountPoolBroker({
      pool,
      now: () => now,
      idGenerator: () => `lease-${++leaseIndex}`,
      tokenResolver: async () => ({
        accessToken: "access",
        accessExpiresAt: 100_000,
      }),
    });

    for (let i = 0; i < 12; i++) {
      nextAccountId = "a";
      const leased = await broker.lease({
        providerId: "anthropic-subscription",
        sessionKey: `session-${i}`,
      });
      await broker.report({
        leaseId: leased?.leaseId ?? "",
        ok: false,
        httpStatus: 503,
      });
      nextAccountId = "b";
      now += 1_000;
      await broker.lease({
        providerId: "anthropic-subscription",
        sessionKey: `session-${i}`,
      });
      now += 1_000;
    }

    const failovers =
      broker.snapshot().providers["anthropic-subscription"]?.recentFailovers ??
      [];
    expect(failovers).toHaveLength(10);
    expect(failovers[0]?.atMs).toBe(6_000);
    expect(failovers[9]?.atMs).toBe(24_000);
  });
});
