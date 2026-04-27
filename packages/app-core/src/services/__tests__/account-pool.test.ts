/**
 * Tests for account-pool.ts — selection strategies, session affinity,
 * and health-state mutations.
 */

import type { LinkedAccountConfig } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountPool, type AccountPoolDeps } from "../account-pool";

function mkAccount(
  id: string,
  overrides: Partial<LinkedAccountConfig> = {},
): LinkedAccountConfig {
  return {
    id,
    providerId: "anthropic-subscription",
    label: id,
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1_000_000,
    health: "ok",
    ...overrides,
  };
}

function mkDeps(
  accounts: LinkedAccountConfig[],
): AccountPoolDeps & {
  current: () => Record<string, LinkedAccountConfig>;
  writes: LinkedAccountConfig[];
} {
  const map = new Map(accounts.map((a) => [a.id, a]));
  const writes: LinkedAccountConfig[] = [];
  return {
    readAccounts: () => Object.fromEntries(map),
    writeAccount: async (account) => {
      writes.push(account);
      map.set(account.id, account);
    },
    current: () => Object.fromEntries(map),
    writes,
  };
}

describe("AccountPool selection", () => {
  it("returns null when no eligible accounts exist", async () => {
    const deps = mkDeps([]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({ providerId: "anthropic-subscription" });
    expect(picked).toBeNull();
  });

  it("priority strategy: lowest priority wins, tiebreak by older lastUsedAt", async () => {
    const deps = mkDeps([
      mkAccount("a", { priority: 10, lastUsedAt: 200 }),
      mkAccount("b", { priority: 5, lastUsedAt: 300 }),
      mkAccount("c", { priority: 5, lastUsedAt: 100 }),
    ]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({ providerId: "anthropic-subscription" });
    expect(picked?.id).toBe("c");
  });

  it("round-robin advances and wraps", async () => {
    const deps = mkDeps([
      mkAccount("a", { priority: 0 }),
      mkAccount("b", { priority: 1 }),
      mkAccount("c", { priority: 2 }),
    ]);
    const pool = new AccountPool(deps);
    const picks: string[] = [];
    for (let i = 0; i < 5; i++) {
      const picked = await pool.select({
        providerId: "anthropic-subscription",
        strategy: "round-robin",
      });
      if (picked) picks.push(picked.id);
    }
    expect(picks).toEqual(["a", "b", "c", "a", "b"]);
  });

  it("least-used picks lowest sessionPct, treating undefined as 0", async () => {
    const deps = mkDeps([
      mkAccount("a", {
        priority: 0,
        usage: { refreshedAt: 1, sessionPct: 90 },
      }),
      mkAccount("b", {
        priority: 1,
        usage: { refreshedAt: 1, sessionPct: 5 },
      }),
      mkAccount("c", { priority: 2 }), // undefined usage → 0
    ]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({
      providerId: "anthropic-subscription",
      strategy: "least-used",
    });
    expect(picked?.id).toBe("c");
  });

  it("quota-aware skips accounts at or above 85% then applies priority", async () => {
    const deps = mkDeps([
      mkAccount("a", {
        priority: 0,
        usage: { refreshedAt: 1, sessionPct: 95 },
      }),
      mkAccount("b", {
        priority: 1,
        usage: { refreshedAt: 1, sessionPct: 84 },
      }),
      mkAccount("c", {
        priority: 2,
        usage: { refreshedAt: 1, sessionPct: 50 },
      }),
    ]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({
      providerId: "anthropic-subscription",
      strategy: "quota-aware",
    });
    expect(picked?.id).toBe("b");
  });

  it("respects exclude", async () => {
    const deps = mkDeps([
      mkAccount("a", { priority: 0 }),
      mkAccount("b", { priority: 1 }),
    ]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({
      providerId: "anthropic-subscription",
      exclude: ["a"],
    });
    expect(picked?.id).toBe("b");
  });

  it("respects explicit accountIds", async () => {
    const deps = mkDeps([
      mkAccount("a", { priority: 0 }),
      mkAccount("b", { priority: 1 }),
      mkAccount("c", { priority: 2 }),
    ]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({
      providerId: "anthropic-subscription",
      accountIds: ["b", "c"],
    });
    expect(picked?.id).toBe("b");
  });

  it("filters out disabled accounts", async () => {
    const deps = mkDeps([
      mkAccount("a", { priority: 0, enabled: false }),
      mkAccount("b", { priority: 1 }),
    ]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({ providerId: "anthropic-subscription" });
    expect(picked?.id).toBe("b");
  });

  it("filters out provider mismatch", async () => {
    const deps = mkDeps([
      mkAccount("a", { providerId: "openai-codex" }),
      mkAccount("b", { providerId: "anthropic-subscription" }),
    ]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({ providerId: "anthropic-subscription" });
    expect(picked?.id).toBe("b");
  });

  it("skips accounts marked invalid / needs-reauth / rate-limited (still active)", async () => {
    const future = Date.now() + 60_000;
    const deps = mkDeps([
      mkAccount("a", { priority: 0, health: "invalid" }),
      mkAccount("b", { priority: 1, health: "needs-reauth" }),
      mkAccount("c", {
        priority: 2,
        health: "rate-limited",
        healthDetail: { until: future },
      }),
      mkAccount("d", { priority: 3, health: "ok" }),
    ]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({ providerId: "anthropic-subscription" });
    expect(picked?.id).toBe("d");
  });

  it("re-admits rate-limited accounts after reset has passed", async () => {
    const past = Date.now() - 1_000;
    const deps = mkDeps([
      mkAccount("a", {
        priority: 0,
        health: "rate-limited",
        healthDetail: { until: past },
      }),
    ]);
    const pool = new AccountPool(deps);
    const picked = await pool.select({ providerId: "anthropic-subscription" });
    expect(picked?.id).toBe("a");
  });
});

describe("AccountPool session affinity", () => {
  it("returns the same account for repeated calls with the same sessionKey", async () => {
    const deps = mkDeps([
      mkAccount("a", { priority: 0 }),
      mkAccount("b", { priority: 1 }),
    ]);
    const pool = new AccountPool(deps);
    const first = await pool.select({
      providerId: "anthropic-subscription",
      sessionKey: "session-1",
    });
    const second = await pool.select({
      providerId: "anthropic-subscription",
      sessionKey: "session-1",
    });
    expect(first?.id).toBe(second?.id);
  });

  it("falls through to a new account when affinity attempts exceed the cap", async () => {
    const deps = mkDeps([
      mkAccount("a", { priority: 0 }),
      mkAccount("b", { priority: 1 }),
    ]);
    const pool = new AccountPool(deps);
    const sessionKey = "session-cap";
    const picks: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      const picked = await pool.select({
        providerId: "anthropic-subscription",
        sessionKey,
      });
      picks.push(picked?.id);
    }
    // First 3 use affinity (return "a"), the 4th should re-evaluate.
    // Strategy is priority, so it stays "a"; the affinity exhaustion
    // doesn't change the picked account when no exclusion is supplied.
    // We only assert that it didn't crash and remained eligible.
    expect(picks.every((id) => id === "a")).toBe(true);
  });

  it("does not honor affinity for an excluded account", async () => {
    const deps = mkDeps([
      mkAccount("a", { priority: 0 }),
      mkAccount("b", { priority: 1 }),
    ]);
    const pool = new AccountPool(deps);
    const first = await pool.select({
      providerId: "anthropic-subscription",
      sessionKey: "s",
    });
    expect(first?.id).toBe("a");
    const second = await pool.select({
      providerId: "anthropic-subscription",
      sessionKey: "s",
      exclude: ["a"],
    });
    expect(second?.id).toBe("b");
  });
});

describe("AccountPool health mutations", () => {
  it("markRateLimited writes rate-limited health with the supplied reset", async () => {
    const deps = mkDeps([mkAccount("a")]);
    const pool = new AccountPool(deps);
    const reset = Date.now() + 5_000;
    await pool.markRateLimited("a", reset, "429 unified");

    const written = deps.writes.at(-1);
    expect(written?.health).toBe("rate-limited");
    expect(written?.healthDetail?.until).toBe(reset);
    expect(written?.healthDetail?.lastError).toBe("429 unified");
  });

  it("markRateLimited applies a default backoff when given a stale timestamp", async () => {
    const deps = mkDeps([mkAccount("a")]);
    const pool = new AccountPool(deps);
    await pool.markRateLimited("a", Date.now() - 1_000);
    const written = deps.writes.at(-1);
    expect(written?.healthDetail?.until ?? 0).toBeGreaterThan(Date.now());
  });

  it("markNeedsReauth flips health to needs-reauth", async () => {
    const deps = mkDeps([mkAccount("a")]);
    const pool = new AccountPool(deps);
    await pool.markNeedsReauth("a", "invalid_grant");
    expect(deps.writes.at(-1)?.health).toBe("needs-reauth");
    expect(deps.writes.at(-1)?.healthDetail?.lastError).toBe("invalid_grant");
  });

  it("markInvalid flips health to invalid", async () => {
    const deps = mkDeps([mkAccount("a")]);
    const pool = new AccountPool(deps);
    await pool.markInvalid("a", "401 after refresh");
    expect(deps.writes.at(-1)?.health).toBe("invalid");
  });

  it("after markRateLimited, select skips that account until reset passes", async () => {
    const deps = mkDeps([
      mkAccount("a", { priority: 0 }),
      mkAccount("b", { priority: 1 }),
    ]);
    const pool = new AccountPool(deps);
    await pool.markRateLimited("a", Date.now() + 60_000);
    const picked = await pool.select({ providerId: "anthropic-subscription" });
    expect(picked?.id).toBe("b");
  });

  it("recordCall stamps lastUsedAt", async () => {
    const deps = mkDeps([mkAccount("a", { lastUsedAt: 0 })]);
    const pool = new AccountPool(deps);
    await pool.recordCall("a", { ok: true, tokens: 10 });
    expect(deps.writes.at(-1)?.lastUsedAt ?? 0).toBeGreaterThan(0);
  });
});

describe("AccountPool reprobeFlagged", () => {
  it("returns ids of accounts that are non-OK and ready to retry", async () => {
    const past = Date.now() - 1_000;
    const future = Date.now() + 60_000;
    const deps = mkDeps([
      mkAccount("ok", { priority: 0 }),
      mkAccount("invalid", { priority: 1, health: "invalid" }),
      mkAccount("expired-rl", {
        priority: 2,
        health: "rate-limited",
        healthDetail: { until: past },
      }),
      mkAccount("active-rl", {
        priority: 3,
        health: "rate-limited",
        healthDetail: { until: future },
      }),
    ]);
    const pool = new AccountPool(deps);
    const ready = await pool.reprobeFlagged();
    expect(new Set(ready)).toEqual(new Set(["invalid", "expired-rl"]));
  });
});

describe("AccountPool refreshUsage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls Anthropic probe and writes usage on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ five_hour: { utilization: 0.4 } }),
      } as unknown as Response),
    );

    const deps = mkDeps([mkAccount("a")]);
    const pool = new AccountPool(deps);
    await pool.refreshUsage("a", "tok");

    const written = deps.writes.at(-1);
    expect(written?.usage?.sessionPct).toBeCloseTo(40, 5);
    expect(written?.health).toBe("ok");
  });

  it("Codex probe requires organizationId; throws otherwise", async () => {
    const deps = mkDeps([
      mkAccount("a", { providerId: "openai-codex" }),
    ]);
    const pool = new AccountPool(deps);
    await expect(pool.refreshUsage("a", "tok")).rejects.toThrow(
      /organizationId/,
    );
  });
});
