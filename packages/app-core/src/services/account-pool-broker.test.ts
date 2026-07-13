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
