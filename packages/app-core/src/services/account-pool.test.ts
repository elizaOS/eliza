/**
 * Unit tests for AccountPool — provider-scoped linked-account selection and
 * eligibility gating. Covers id-collision resolution across providers,
 * priority/round-robin/session-affinity/usage-aware strategies, least-used
 * burst spreading, and the eligibility guard (exclude set, enabled flag,
 * accountIds allow-list, rate-limit re-admission). The pool is driven through
 * injected readAccounts/writeAccount and a stubbed fetch, so no real credential
 * store or provider API is touched.
 */
import { logger } from "@elizaos/core";
import type { LinkedAccountConfig } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { AccountPool } from "./account-pool";

function account(
  providerId: LinkedAccountConfig["providerId"],
  overrides: Partial<LinkedAccountConfig> = {},
): LinkedAccountConfig {
  return {
    id: "shared-id",
    providerId,
    label: providerId,
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
    ...overrides,
  };
}

describe("AccountPool provider-scoped account resolution", () => {
  it("gets the matching provider account when ids collide", () => {
    const accounts = {
      "openai-codex:shared-id": account("openai-codex"),
      "anthropic-subscription:shared-id": account("anthropic-subscription", {
        priority: 1,
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    expect(pool.get("shared-id", "anthropic-subscription")?.providerId).toBe(
      "anthropic-subscription",
    );
    expect(pool.get("shared-id", "openai-codex")?.providerId).toBe(
      "openai-codex",
    );
  });

  it("scopes health mutations to the provider when ids collide", async () => {
    const writes: LinkedAccountConfig[] = [];
    const accounts = {
      "openai-codex:shared-id": account("openai-codex"),
      "anthropic-subscription:shared-id": account("anthropic-subscription"),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async (next) => {
        writes.push(next);
      },
    });

    await pool.markInvalid("shared-id", "expired", {
      providerId: "anthropic-subscription",
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.providerId).toBe("anthropic-subscription");
    expect(writes[0]?.health).toBe("invalid");
  });

  it("runs usage probes against the provider-scoped account", async () => {
    const writes: LinkedAccountConfig[] = [];
    const accounts = {
      "anthropic-subscription:shared-id": account("anthropic-subscription"),
      "openai-codex:shared-id": account("openai-codex", {
        organizationId: "org_1",
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async (next) => {
        writes.push(next);
      },
    });

    await pool.refreshUsage("shared-id", "token", {
      providerId: "openai-codex",
      codexAccountId: "org_1",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 12,
                reset_at: 1_800_000_000,
              },
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.providerId).toBe("openai-codex");
    expect(writes[0]?.usage?.sessionPct).toBe(12);
  });

  it("backfills the Anthropic email from the profile probe during a usage refresh", async () => {
    const writes: LinkedAccountConfig[] = [];
    const accounts = {
      "anthropic-subscription:no-email": account("anthropic-subscription", {
        id: "no-email",
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async (next) => {
        writes.push(next);
      },
    });

    // One fetch stub answers both the usage and profile endpoints by URL.
    await pool.refreshUsage("no-email", "token", {
      providerId: "anthropic-subscription",
      fetch: (async (url: string | URL | Request) =>
        String(url).includes("/profile")
          ? new Response(
              JSON.stringify({ account: { email: "backfilled@example.com" } }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ five_hour: { utilization: 0 } }), {
              status: 200,
            })) as unknown as typeof fetch,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.email).toBe("backfilled@example.com");
    expect(writes[0]?.usage?.sessionPct).toBe(0);
  });

  it("preserves the fetched usage and reports (not fabricates) a failed profile backfill", async () => {
    // The profile boundary throws typed errors (401/5xx/malformed/transport).
    // refreshUsage must NOT let that discard the successfully fetched usage,
    // must NOT write an email, and must surface the failure observably.
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (const profileResponse of [
        () => new Response("{}", { status: 500 }),
        () => new Response("{}", { status: 401 }),
        () => new Response("not-json", { status: 200 }),
        () => {
          throw new TypeError("network down");
        },
      ]) {
        warnSpy.mockClear();
        const writes: LinkedAccountConfig[] = [];
        const accounts = {
          "anthropic-subscription:no-email": account("anthropic-subscription", {
            id: "no-email",
          }),
        };
        const pool = new AccountPool({
          readAccounts: () => accounts,
          writeAccount: async (next) => {
            writes.push(next);
          },
        });

        await pool.refreshUsage("no-email", "token", {
          providerId: "anthropic-subscription",
          fetch: (async (url: string | URL | Request) =>
            String(url).includes("/profile")
              ? profileResponse()
              : new Response(
                  JSON.stringify({ five_hour: { utilization: 0.5 } }),
                  { status: 200 },
                )) as unknown as typeof fetch,
        });

        // Usage survived the identity failure…
        expect(writes).toHaveLength(1);
        expect(writes[0]?.usage?.sessionPct).toBe(50);
        // …no fabricated identity…
        expect(writes[0]?.email).toBeUndefined();
        // …and the failure was reported, not swallowed.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain("no-email");
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT re-probe the profile when the account already has an email", async () => {
    const profileUrls: string[] = [];
    const accounts = {
      "anthropic-subscription:has-email": account("anthropic-subscription", {
        id: "has-email",
        email: "existing@example.com",
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    await pool.refreshUsage("has-email", "token", {
      providerId: "anthropic-subscription",
      fetch: (async (url: string | URL | Request) => {
        if (String(url).includes("/profile")) profileUrls.push(String(url));
        return new Response(JSON.stringify({ five_hour: { utilization: 0 } }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });

    expect(profileUrls).toHaveLength(0);
  });

  it("selects among multiple accounts for the same provider by priority", async () => {
    const accounts = {
      "openai-codex:personal": account("openai-codex", {
        id: "personal",
        priority: 5,
        createdAt: 2,
      }),
      "openai-codex:work": account("openai-codex", {
        id: "work",
        priority: 1,
        createdAt: 1,
      }),
      "anthropic-subscription:work": account("anthropic-subscription", {
        id: "work",
        priority: 0,
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    await expect(
      pool.select({ providerId: "openai-codex" }),
    ).resolves.toMatchObject({
      id: "work",
      providerId: "openai-codex",
    });
  });

  it("round-robins across multiple accounts for one provider", async () => {
    const accounts = {
      "openai-codex:first": account("openai-codex", {
        id: "first",
        priority: 0,
        createdAt: 1,
      }),
      "openai-codex:second": account("openai-codex", {
        id: "second",
        priority: 1,
        createdAt: 2,
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    await expect(
      pool.select({ providerId: "openai-codex", strategy: "round-robin" }),
    ).resolves.toMatchObject({ id: "first" });
    await expect(
      pool.select({ providerId: "openai-codex", strategy: "round-robin" }),
    ).resolves.toMatchObject({ id: "second" });
    await expect(
      pool.select({ providerId: "openai-codex", strategy: "round-robin" }),
    ).resolves.toMatchObject({ id: "first" });
  });

  it("keeps session affinity across multiple accounts for one provider", async () => {
    const accounts = {
      "openai-codex:first": account("openai-codex", {
        id: "first",
        priority: 0,
        createdAt: 1,
      }),
      "openai-codex:second": account("openai-codex", {
        id: "second",
        priority: 1,
        createdAt: 2,
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    const first = await pool.select({
      providerId: "openai-codex",
      strategy: "round-robin",
      sessionKey: "agent-a",
    });
    const second = await pool.select({
      providerId: "openai-codex",
      strategy: "round-robin",
      sessionKey: "agent-a",
    });
    const otherSession = await pool.select({
      providerId: "openai-codex",
      strategy: "round-robin",
      sessionKey: "agent-b",
    });

    expect(first?.id).toBe("first");
    expect(second?.id).toBe("first");
    expect(otherSession?.id).toBe("second");
  });

  it("burst-spreads least-used across equal-usage accounts (distinct fresh sessions)", async () => {
    // Three accounts with identical usage + age. A burst of fresh-sessionKey
    // least-used spawns must spread across DISTINCT accounts (the in-memory
    // recentlySelectedAt tiebreak), not stack on whichever sorts first.
    const accounts = {
      "openai-codex:a": account("openai-codex", {
        id: "a",
        priority: 0,
        createdAt: 1,
        usage: { sessionPct: 10, refreshedAt: 1 },
      }),
      "openai-codex:b": account("openai-codex", {
        id: "b",
        priority: 0,
        createdAt: 1,
        usage: { sessionPct: 10, refreshedAt: 1 },
      }),
      "openai-codex:c": account("openai-codex", {
        id: "c",
        priority: 0,
        createdAt: 1,
        usage: { sessionPct: 10, refreshedAt: 1 },
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });
    const picked = new Set<string>();
    for (const sessionKey of ["s1", "s2", "s3"]) {
      const sel = await pool.select({
        providerId: "openai-codex",
        strategy: "least-used",
        sessionKey,
      });
      if (sel) picked.add(sel.id);
    }
    expect(picked.size).toBe(3); // spread across all three, no stacking
  });

  it("uses usage-aware strategies across same-provider accounts", async () => {
    const accounts = {
      "openai-codex:near-limit": account("openai-codex", {
        id: "near-limit",
        priority: 0,
        usage: { sessionPct: 95, refreshedAt: 1 },
      }),
      "openai-codex:available": account("openai-codex", {
        id: "available",
        priority: 1,
        usage: { sessionPct: 20, refreshedAt: 1 },
      }),
      "openai-codex:least-used": account("openai-codex", {
        id: "least-used",
        priority: 2,
        usage: { sessionPct: 5, refreshedAt: 1 },
      }),
    };
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

    await expect(
      pool.select({ providerId: "openai-codex", strategy: "quota-aware" }),
    ).resolves.toMatchObject({ id: "available" });
    await expect(
      pool.select({ providerId: "openai-codex", strategy: "least-used" }),
    ).resolves.toMatchObject({ id: "least-used" });
  });
});

// Eligibility gating (`filterEligible`, account-pool.ts:189-215) is the guard
// every strategy runs behind: provider scoping, the caller's exclude set, the
// `enabled` flag, an explicit `accountIds` allow-list, and the rate-limit
// re-admission rule (a rate-limited account rejoins the pool ONLY once its
// `healthDetail.until` reset has elapsed; `invalid`/`needs-reauth`/`unknown`
// never rejoin). It is private, so these drive it through `select()` — null
// means "filtered out", a returned account means "passed the gate".
describe("AccountPool.filterEligible eligibility gating", () => {
  const poolOf = (accounts: Record<string, LinkedAccountConfig>) =>
    new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

  it("fails over past an excluded account, and returns null when all are excluded", async () => {
    const accounts = {
      "openai-codex:a": account("openai-codex", { id: "a", priority: 0 }),
      "openai-codex:b": account("openai-codex", { id: "b", priority: 1 }),
    };
    const pool = poolOf(accounts);

    // priority would pick "a" (lower number) — excluding it fails over to "b".
    await expect(
      pool.select({ providerId: "openai-codex", exclude: ["a"] }),
    ).resolves.toMatchObject({ id: "b" });
    // excluding every account leaves the pool empty.
    await expect(
      pool.select({ providerId: "openai-codex", exclude: ["a", "b"] }),
    ).resolves.toBeNull();
  });

  it("never selects a disabled account even when it sorts first", async () => {
    const accounts = {
      "openai-codex:on": account("openai-codex", { id: "on", priority: 5 }),
      // higher priority (0) but disabled → must be skipped.
      "openai-codex:off": account("openai-codex", {
        id: "off",
        priority: 0,
        enabled: false,
      }),
    };
    await expect(
      poolOf(accounts).select({ providerId: "openai-codex" }),
    ).resolves.toMatchObject({ id: "on" });

    // a pool whose only account is disabled resolves to null.
    await expect(
      poolOf({
        "openai-codex:off": account("openai-codex", {
          id: "off",
          enabled: false,
        }),
      }).select({ providerId: "openai-codex" }),
    ).resolves.toBeNull();
  });

  it("restricts to an explicit accountIds allow-list (and treats [] as unrestricted)", async () => {
    const accounts = {
      "openai-codex:a": account("openai-codex", { id: "a", priority: 0 }),
      "openai-codex:b": account("openai-codex", { id: "b", priority: 1 }),
      "openai-codex:c": account("openai-codex", { id: "c", priority: 2 }),
    };
    const pool = poolOf(accounts);

    // allow-list {b,c} → priority picks "b" even though "a" outranks it.
    await expect(
      pool.select({ providerId: "openai-codex", accountIds: ["b", "c"] }),
    ).resolves.toMatchObject({ id: "b" });
    // an allow-list that matches nothing in the pool → null.
    await expect(
      pool.select({
        providerId: "openai-codex",
        accountIds: ["does-not-exist"],
      }),
    ).resolves.toBeNull();
    // an EMPTY allow-list is treated as "no restriction" (explicit === null).
    await expect(
      pool.select({ providerId: "openai-codex", accountIds: [] }),
    ).resolves.toMatchObject({ id: "a" });
  });

  it("readmits a rate-limited account only after its reset elapses, and never readmits invalid/needs-reauth", async () => {
    const past = 1; // epoch ms ≈ 1970 → well before now
    const future = Date.now() + 3_600_000;

    // rate-limited with an elapsed reset → back in the pool.
    await expect(
      poolOf({
        "openai-codex:rl": account("openai-codex", {
          id: "rl",
          health: "rate-limited",
          healthDetail: { until: past },
        }),
      }).select({ providerId: "openai-codex" }),
    ).resolves.toMatchObject({ id: "rl" });

    // rate-limited with a reset still in the future → excluded.
    await expect(
      poolOf({
        "openai-codex:rl": account("openai-codex", {
          id: "rl",
          health: "rate-limited",
          healthDetail: { until: future },
        }),
      }).select({ providerId: "openai-codex" }),
    ).resolves.toBeNull();

    // rate-limited with no `until` at all → excluded (no reset to clear).
    await expect(
      poolOf({
        "openai-codex:rl": account("openai-codex", {
          id: "rl",
          health: "rate-limited",
        }),
      }).select({ providerId: "openai-codex" }),
    ).resolves.toBeNull();

    // invalid is never readmitted, even with an elapsed `until`.
    await expect(
      poolOf({
        "openai-codex:bad": account("openai-codex", {
          id: "bad",
          health: "invalid",
          healthDetail: { until: past },
        }),
      }).select({ providerId: "openai-codex" }),
    ).resolves.toBeNull();

    // needs-reauth is likewise never readmitted.
    await expect(
      poolOf({
        "openai-codex:reauth": account("openai-codex", {
          id: "reauth",
          health: "needs-reauth",
        }),
      }).select({ providerId: "openai-codex" }),
    ).resolves.toBeNull();
  });

  it("fails over from a still-throttled account to a healthy one for the same provider", async () => {
    const future = Date.now() + 3_600_000;
    const accounts = {
      // higher priority but throttled until the future → must be skipped.
      "openai-codex:throttled": account("openai-codex", {
        id: "throttled",
        priority: 0,
        health: "rate-limited",
        healthDetail: { until: future },
      }),
      "openai-codex:healthy": account("openai-codex", {
        id: "healthy",
        priority: 5,
      }),
    };
    await expect(
      poolOf(accounts).select({ providerId: "openai-codex" }),
    ).resolves.toMatchObject({ id: "healthy" });
  });
});
