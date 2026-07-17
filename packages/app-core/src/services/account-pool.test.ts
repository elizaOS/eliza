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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountPool,
  configureDefaultAccountPoolSelection,
  selectionForProvider,
} from "./account-pool";

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

afterEach(() => {
  vi.useRealTimers();
  configureDefaultAccountPoolSelection();
});

describe("AccountPool provider-scoped account resolution", () => {
  it("delegates metadata deletion with the provider-qualified account id", async () => {
    const deleteAccount = vi.fn(async () => {});
    const pool = new AccountPool({
      readAccounts: () => ({}),
      writeAccount: async () => {},
      deleteAccount,
    });

    await pool.deleteMetadata("openai-codex", "shared-id");

    expect(deleteAccount).toHaveBeenCalledOnce();
    expect(deleteAccount).toHaveBeenCalledWith("openai-codex", "shared-id");
  });

  it("preserves explicit priority provenance and defaults new accounts to generated", async () => {
    const writes: LinkedAccountConfig[] = [];
    const existing = account("anthropic-subscription", {
      id: "existing",
      priority: 7,
      prioritySource: "explicit",
    });
    const pool = new AccountPool({
      readAccounts: () => ({ "anthropic-subscription:existing": existing }),
      writeAccount: async (next) => {
        writes.push(next);
      },
    });

    await pool.upsert({
      ...existing,
      label: "Relinked",
      prioritySource: undefined,
    });
    await pool.upsert(
      account("anthropic-subscription", { id: "new", priority: 8 }),
    );

    expect(writes[0]?.prioritySource).toBe("explicit");
    expect(writes[1]?.prioritySource).toBe("generated");
  });

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
                  JSON.stringify({ five_hour: { utilization: 50 } }),
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

// ── reset-soonest strategy + selectionState dry-run ──────────────────
// Reset-soonest prefers the account whose weekly budget refunds first (its
// resetsAt is nearest), holding freshly-reset accounts in reserve. When no
// reset instants are known it degrades to least-recently-used. selectionState
// is a non-mutating mirror the accounts API/UI polls to label the active row.
describe("AccountPool reset-soonest selection", () => {
  const poolOf = (accounts: Record<string, LinkedAccountConfig>) =>
    new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async () => {},
    });

  const now = Date.now();

  it("serves the account whose weekly limit resets soonest", async () => {
    const accounts = {
      "anthropic-subscription:soon": account("anthropic-subscription", {
        id: "soon",
        priority: 5,
        usage: { sessionPct: 40, resetsAt: now + 3_600_000, refreshedAt: now },
      }),
      "anthropic-subscription:later": account("anthropic-subscription", {
        id: "later",
        priority: 0,
        usage: {
          sessionPct: 10,
          resetsAt: now + 50 * 3_600_000,
          refreshedAt: now,
        },
      }),
    };
    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "reset-soonest",
      }),
    ).resolves.toMatchObject({ id: "soon" });
  });

  it("skips over-quota accounts before applying reset ordering", async () => {
    const accounts = {
      "anthropic-subscription:capped": account("anthropic-subscription", {
        id: "capped",
        usage: { sessionPct: 96, resetsAt: now + 3_600_000, refreshedAt: now },
      }),
      "anthropic-subscription:open": account("anthropic-subscription", {
        id: "open",
        usage: {
          sessionPct: 20,
          resetsAt: now + 20 * 3_600_000,
          refreshedAt: now,
        },
      }),
    };
    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "reset-soonest",
      }),
    ).resolves.toMatchObject({ id: "open" });
  });

  it("selectionState reports reset-soonest reason without mutating state", () => {
    const accounts = {
      "anthropic-subscription:soon": account("anthropic-subscription", {
        id: "soon",
        usage: { sessionPct: 40, resetsAt: now + 3_600_000, refreshedAt: now },
      }),
      "anthropic-subscription:later": account("anthropic-subscription", {
        id: "later",
        usage: {
          sessionPct: 10,
          resetsAt: now + 50 * 3_600_000,
          refreshedAt: now,
        },
      }),
    };
    const pool = poolOf(accounts);
    const state = pool.selectionState(
      "anthropic-subscription",
      "reset-soonest",
    );
    expect(state).toEqual({ activeAccountId: "soon", reason: "reset-soonest" });
    // Idempotent: a second call returns the same pick (no rotation side effect).
    expect(
      pool.selectionState("anthropic-subscription", "reset-soonest"),
    ).toEqual(state);
  });

  it("selectionState honors configured account-id pins", () => {
    const accounts = {
      "anthropic-subscription:soon": account("anthropic-subscription", {
        id: "soon",
        usage: { sessionPct: 10, resetsAt: now + 3_600_000, refreshedAt: now },
      }),
      "anthropic-subscription:pinned": account("anthropic-subscription", {
        id: "pinned",
        usage: {
          sessionPct: 10,
          resetsAt: now + 50 * 3_600_000,
          refreshedAt: now,
        },
      }),
    };
    expect(
      poolOf(accounts).selectionState(
        "anthropic-subscription",
        "reset-soonest",
        { accountIds: ["pinned"] },
      ),
    ).toEqual({ activeAccountId: "pinned", reason: "only-eligible" });
  });

  it("selectionState falls back to least-recently-throttled when resets unknown", () => {
    const accounts = {
      "anthropic-subscription:stale": account("anthropic-subscription", {
        id: "stale",
        lastUsedAt: now - 100_000,
      }),
      "anthropic-subscription:recent": account("anthropic-subscription", {
        id: "recent",
        lastUsedAt: now - 1_000,
      }),
    };
    expect(
      poolOf(accounts).selectionState(
        "anthropic-subscription",
        "reset-soonest",
      ),
    ).toEqual({
      activeAccountId: "stale",
      reason: "least-recently-throttled",
    });
  });

  it("selectionState returns only-eligible for a single account", () => {
    const accounts = {
      "anthropic-subscription:solo": account("anthropic-subscription", {
        id: "solo",
      }),
    };
    expect(
      poolOf(accounts).selectionState(
        "anthropic-subscription",
        "reset-soonest",
      ),
    ).toEqual({ activeAccountId: "solo", reason: "only-eligible" });
  });
});

// ── drain-soonest-reset strategy ─────────────────────────────────────
// Drain-soonest-reset honors only explicitly hand-set priority before weekly
// drain ordering. Generated creation-order priority is display metadata, not a
// hard override. Within the non-explicit pool it spends the relevant weekly
// model bucket whose reset arrives first, then the lower utilization bucket,
// with subscription end only as a final-days booster/tiebreak.
describe("AccountPool drain-soonest-reset selection", () => {
  const fixedNow = 1_800_000_000_000;
  const hour = 60 * 60 * 1000;
  const poolOf = (
    accounts: Record<string, LinkedAccountConfig>,
    writes: LinkedAccountConfig[] = [],
  ) =>
    new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async (next) => {
        writes.push(next);
        accounts[`${next.providerId}:${next.id}`] = next;
      },
    });

  it("prefers soonest weekly reset over generated priority", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const accounts = {
      "anthropic-subscription:generated-top": account(
        "anthropic-subscription",
        {
          id: "generated-top",
          priority: 0,
          prioritySource: "generated",
          usage: {
            weeklyPct: 10,
            resetsAt: fixedNow + 30 * hour,
            refreshedAt: fixedNow,
          },
        },
      ),
      "anthropic-subscription:soon-reset": account("anthropic-subscription", {
        id: "soon-reset",
        priority: 10,
        prioritySource: "generated",
        usage: {
          weeklyPct: 80,
          resetsAt: fixedNow + 2 * hour,
          refreshedAt: fixedNow,
        },
      }),
    };

    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
      }),
    ).resolves.toMatchObject({ id: "soon-reset" });
  });

  it("uses weekly headroom when resets tie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const accounts = {
      "anthropic-subscription:busy": account("anthropic-subscription", {
        id: "busy",
        usage: {
          weeklyPct: 70,
          resetsAt: fixedNow + 5 * hour,
          refreshedAt: fixedNow,
        },
      }),
      "anthropic-subscription:open": account("anthropic-subscription", {
        id: "open",
        usage: {
          weeklyPct: 20,
          resetsAt: fixedNow + 5 * hour,
          refreshedAt: fixedNow,
        },
      }),
    };

    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
      }),
    ).resolves.toMatchObject({ id: "open" });
  });

  it("skips a session-exhausted account without changing weekly ordering", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const accounts = {
      "anthropic-subscription:exhausted": account("anthropic-subscription", {
        id: "exhausted",
        usage: {
          sessionPct: 100,
          weeklyPct: 10,
          resetsAt: fixedNow + hour,
          refreshedAt: fixedNow,
        },
      }),
      "anthropic-subscription:ready": account("anthropic-subscription", {
        id: "ready",
        usage: {
          sessionPct: 20,
          weeklyPct: 60,
          resetsAt: fixedNow + 10 * hour,
          refreshedAt: fixedNow,
        },
      }),
    };

    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
      }),
    ).resolves.toMatchObject({ id: "ready" });
  });

  it("uses the requested model bucket and falls back to blended weeklyPct when unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const accounts = {
      "anthropic-subscription:fable-soon": account("anthropic-subscription", {
        id: "fable-soon",
        usage: {
          weeklyPct: 90,
          resetsAt: fixedNow + 30 * hour,
          weeklyModelBuckets: {
            Fable: { pct: 90, resetsAt: fixedNow + hour },
          },
          refreshedAt: fixedNow,
        },
      }),
      "anthropic-subscription:blended-soon": account("anthropic-subscription", {
        id: "blended-soon",
        usage: {
          weeklyPct: 10,
          resetsAt: fixedNow + 2 * hour,
          weeklyModelBuckets: {
            Sonnet: { pct: 5, resetsAt: fixedNow + 10 * hour },
          },
          refreshedAt: fixedNow,
        },
      }),
    };

    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
        model: "claude-fable-5",
      }),
    ).resolves.toMatchObject({ id: "fable-soon" });
    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
        model: "opus",
      }),
    ).resolves.toMatchObject({ id: "blended-soon" });
  });

  it("preserves a weekly-scoped Fable reset for drain ordering", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const accounts = {
      "anthropic-subscription:fable-window": account("anthropic-subscription", {
        id: "fable-window",
        usage: {
          sessionPct: 1,
          weeklyPct: 5,
          resetsAt: fixedNow + 20 * hour,
          weeklyModelBuckets: {
            Fable: { pct: 12, resetsAt: fixedNow + hour },
          },
          refreshedAt: fixedNow,
        },
      }),
      "anthropic-subscription:blended-window": account(
        "anthropic-subscription",
        {
          id: "blended-window",
          usage: {
            sessionPct: 1,
            weeklyPct: 1,
            resetsAt: fixedNow + 2 * hour,
            refreshedAt: fixedNow,
          },
        },
      ),
    };

    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
        model: "claude-fable-5",
      }),
    ).resolves.toMatchObject({ id: "fable-window" });
  });

  it("sorts a missing weekly reset after a known reset as a fail-safe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const accounts = {
      "anthropic-subscription:missing-reset": account(
        "anthropic-subscription",
        {
          id: "missing-reset",
          usage: {
            sessionPct: 1,
            weeklyPct: 0,
            refreshedAt: fixedNow,
          },
        },
      ),
      "anthropic-subscription:known-reset": account("anthropic-subscription", {
        id: "known-reset",
        usage: {
          sessionPct: 1,
          weeklyPct: 99,
          resetsAt: fixedNow + 10 * hour,
          refreshedAt: fixedNow,
        },
      }),
    };

    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
      }),
    ).resolves.toMatchObject({ id: "known-reset" });
  });

  it("Codex 429 cooldown adopts the provider-authoritative 5h reset (no 60s ping-pong)", async () => {
    // usage.resetsAt for openai-codex is the PRIMARY FIVE-HOUR window reset
    // (see LinkedAccountUsage contract) — exactly the 429 cooldown clock. A
    // caller passing no/short heuristic must not re-admit the account every
    // 60s into a still-limited ~5h window (the documented ping-pong).
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const codexReset = fixedNow + 3 * hour;
    const writes: LinkedAccountConfig[] = [];
    const accounts = {
      "openai-codex:cdx": account("openai-codex", {
        id: "cdx",
        usage: {
          sessionPct: 100,
          resetsAt: codexReset,
          refreshedAt: fixedNow,
        },
      }),
    };
    const pool = poolOf(accounts, writes);

    // Caller has only the 60s probe default (passes a non-finite/elapsed until).
    await pool.markRateLimited("cdx", Number.NaN, "HTTP 429", {
      providerId: "openai-codex",
    });

    expect(writes[0]?.health).toBe("rate-limited");
    expect(writes[0]?.healthDetail?.until).toBe(codexReset);
  });

  it("Anthropic 429 cooldown ignores the weekly resetsAt (would strand for days)", async () => {
    // usage.resetsAt for anthropic-subscription is the SEVEN-DAY weekly reset
    // used by drain ordering. Adopting it as a 429 cooldown would bench a
    // session-limited account for up to a week; the caller heuristic must win.
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const weeklyReset = fixedNow + 6 * 24 * hour;
    const writes: LinkedAccountConfig[] = [];
    const accounts = {
      "anthropic-subscription:ant": account("anthropic-subscription", {
        id: "ant",
        usage: {
          weeklyPct: 40,
          resetsAt: weeklyReset,
          refreshedAt: fixedNow,
        },
      }),
    };
    const pool = poolOf(accounts, writes);

    // No usable caller until → falls back to the 60s heuristic, NOT the
    // weekly clock.
    await pool.markRateLimited("ant", Number.NaN, "HTTP 429", {
      providerId: "anthropic-subscription",
    });
    expect(writes[0]?.healthDetail?.until).toBe(fixedNow + 60_000);
    expect(writes[0]?.healthDetail?.until).not.toBe(weeklyReset);

    // An explicit caller until (e.g. provider retry-after) is respected.
    await pool.markRateLimited("ant", fixedNow + 15 * 60 * 1000, "HTTP 429", {
      providerId: "anthropic-subscription",
    });
    expect(writes[1]?.healthDetail?.until).toBe(fixedNow + 15 * 60 * 1000);
  });

  it("keeps 429 cooldown separate from weekly ranking after readmission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const writes: LinkedAccountConfig[] = [];
    const accounts = {
      "anthropic-subscription:cooling": account("anthropic-subscription", {
        id: "cooling",
        usage: {
          weeklyPct: 90,
          resetsAt: fixedNow + hour,
          refreshedAt: fixedNow,
        },
      }),
      "anthropic-subscription:later": account("anthropic-subscription", {
        id: "later",
        usage: {
          weeklyPct: 5,
          resetsAt: fixedNow + 10 * hour,
          refreshedAt: fixedNow,
        },
      }),
    };
    const pool = poolOf(accounts, writes);
    await pool.markRateLimited("cooling", fixedNow + 30 * 60 * 1000, "429", {
      providerId: "anthropic-subscription",
    });
    expect(writes[0]?.healthDetail?.until).toBe(fixedNow + 30 * 60 * 1000);

    await expect(
      pool.select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
      }),
    ).resolves.toMatchObject({ id: "later" });
    vi.setSystemTime(fixedNow + 31 * 60 * 1000);
    await expect(
      pool.select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
      }),
    ).resolves.toMatchObject({ id: "cooling" });
  });

  it("uses subscription end as a final-days tiebreaker after reset and utilization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const accounts = {
      "anthropic-subscription:renewing": account("anthropic-subscription", {
        id: "renewing",
        createdAt: 1,
        usage: {
          weeklyPct: 30,
          resetsAt: fixedNow + 4 * hour,
          refreshedAt: fixedNow,
        },
        subscriptionEndsAt: fixedNow + 20 * 24 * hour,
      }),
      "anthropic-subscription:ending": account("anthropic-subscription", {
        id: "ending",
        createdAt: 2,
        usage: {
          weeklyPct: 30,
          resetsAt: fixedNow + 4 * hour,
          refreshedAt: fixedNow,
        },
        subscriptionEndsAt: fixedNow + 2 * hour,
      }),
    };

    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
      }),
    ).resolves.toMatchObject({ id: "ending" });
  });

  it("honors an explicitly hand-set priority as a hard override", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const accounts = {
      "anthropic-subscription:manual": account("anthropic-subscription", {
        id: "manual",
        priority: 0,
        prioritySource: "explicit",
        usage: {
          weeklyPct: 99,
          resetsAt: fixedNow + 50 * hour,
          refreshedAt: fixedNow,
        },
      }),
      "anthropic-subscription:soon": account("anthropic-subscription", {
        id: "soon",
        priority: 10,
        prioritySource: "generated",
        usage: {
          weeklyPct: 5,
          resetsAt: fixedNow + hour,
          refreshedAt: fixedNow,
        },
      }),
    };

    await expect(
      poolOf(accounts).select({
        providerId: "anthropic-subscription",
        strategy: "drain-soonest-reset",
      }),
    ).resolves.toMatchObject({ id: "manual" });
  });

  it("defaults Anthropic subscription to drain-soonest-reset when unconfigured", () => {
    expect(selectionForProvider("anthropic-subscription").strategy).toBe(
      "drain-soonest-reset",
    );
    configureDefaultAccountPoolSelection({
      accountStrategies: { "anthropic-subscription": "priority" },
    });
    expect(selectionForProvider("anthropic-subscription").strategy).toBe(
      "priority",
    );
  });
});
