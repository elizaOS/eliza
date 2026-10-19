import { describe, expect, it } from "vitest";
import type { AccountPool } from "./account-pool.js";
import { AccountPoolBroker } from "./account-pool-broker.js";

const NOW = 1_700_000_000_000;

function fakePool(): AccountPool {
  const account = {
    id: "acct-1",
    providerId: "anthropic-api" as const,
    enabled: true,
    token: "sk-test",
  };
  return {
    select: async () => account,
    list: () => [account],
  } as unknown as AccountPool;
}

function makeBroker() {
  let n = 0;
  return new AccountPoolBroker({
    pool: fakePool(),
    now: () => NOW,
    leaseTtlMs: 60_000,
    idGenerator: () => `lease-${++n}`,
    tokenResolver: async () => ({
      accessToken: "sk-test",
      accessExpiresAt: NOW + 60_000,
    }),
  } as never);
}

describe("AccountPoolBroker lease replacement", () => {
  it("keeps one live lease when the same session re-leases", async () => {
    const broker = makeBroker();
    const first = await broker.lease({
      providerId: "anthropic-api",
      sessionKey: "session-a",
    });
    const second = await broker.lease({
      providerId: "anthropic-api",
      sessionKey: "session-a",
    });

    expect(first?.leaseId).toBe("lease-1");
    expect(second?.leaseId).toBe("lease-2");
    expect(broker.health().activeLeases).toBe(1);
    const [account] = Object.values(broker.health().accounts);
    expect(account?.activeLeaseCount).toBe(1);
  });

  it("does not resurrect a replaced lease when the old id is released", async () => {
    const broker = makeBroker();
    const first = await broker.lease({
      providerId: "anthropic-api",
      sessionKey: "session-a",
    });
    await broker.lease({
      providerId: "anthropic-api",
      sessionKey: "session-a",
    });

    expect(broker.release({ leaseId: first?.leaseId ?? "" }).released).toBe(
      false,
    );
    expect(broker.health().activeLeases).toBe(1);
  });
});
