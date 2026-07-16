/**
 * Consistency guards for the two account-pool surfaces the orchestrator's
 * failover/readiness gates depend on:
 *
 *  1. Round-robin must actually alternate in the production sequence
 *     (select → recordCall → select): `recordCall` bumps `lastUsedAt`, and a
 *     ring ordered by a mutable field reshuffles under the cursor, serving the
 *     same account back-to-back (a,a,b,b,…).
 *  2. The coding-agent bridge's `describe()` healthy count must agree with
 *     what `select()` would serve: a rate-limited account whose
 *     `healthDetail.until` reset has elapsed is selectable again, so reporting
 *     it `healthy: 0` makes the SubAgentRouter refuse a failover respawn that
 *     the pool would happily serve.
 *
 * Together with the strategy suite, this keeps the production pool's broader
 * eligibility surface in the changed-file coverage lane. The pool is driven
 * through injected readAccounts/writeAccount; only
 * `recordCall`'s JSONL usage counter touches disk (a throwaway state dir).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCodingAgentSelectorBridge } from "@elizaos/core";
import type { LinkedAccountConfig } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccountPool,
  configureDefaultAccountPoolSelection,
  isAccountSelectableNow,
  selectionForProvider,
} from "./account-pool";
import { installCodingAgentSelectorBridge } from "./coding-account-bridge";

let stateDir: string;
let prevStateDir: string | undefined;

beforeEach(() => {
  prevStateDir = process.env.ELIZA_STATE_DIR;
  stateDir = mkdtempSync(path.join(tmpdir(), "account-pool-availability-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

function account(
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
    createdAt: 1,
    health: "ok",
    ...overrides,
  };
}

function poolOf(accounts: Record<string, LinkedAccountConfig>): AccountPool {
  return new AccountPool({
    readAccounts: () => accounts,
    writeAccount: async (next) => {
      accounts[`${next.providerId}:${next.id}`] = next;
    },
  });
}

describe("round-robin ring stability under usage recording", () => {
  it("alternates across two equal-priority accounts when recordCall runs between selects", async () => {
    const accounts = {
      "anthropic-subscription:a": account("a", { createdAt: 1 }),
      "anthropic-subscription:b": account("b", { createdAt: 2 }),
    };
    const pool = poolOf(accounts);

    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const sel = await pool.select({
        providerId: "anthropic-subscription",
        strategy: "round-robin",
      });
      expect(sel).not.toBeNull();
      picks.push(sel?.id ?? "none");
      // The production sequence: every served call is recorded, which bumps
      // the account's persisted lastUsedAt before the next selection.
      await pool.recordCall(
        sel?.id ?? "",
        { ok: true },
        { providerId: "anthropic-subscription" },
      );
    }

    // Strict alternation — no back-to-back repeats, both accounts used.
    expect(picks[0]).not.toBe(picks[1]);
    expect(picks[1]).not.toBe(picks[2]);
    expect(picks[2]).not.toBe(picks[3]);
    expect(new Set(picks)).toEqual(new Set(["a", "b"]));
  });
});

describe("describe() healthy count agrees with select() eligibility", () => {
  it("counts a rate-limited account with an ELAPSED reset as healthy (it is selectable)", async () => {
    const accounts = {
      "anthropic-subscription:solo": account("solo", {
        health: "rate-limited",
        healthDetail: { until: Date.now() - 60_000, lastChecked: Date.now() },
      }),
    };
    const pool = poolOf(accounts);
    installCodingAgentSelectorBridge(pool);
    const bridge = getCodingAgentSelectorBridge();
    expect(bridge).not.toBeNull();

    // The pool serves the account (its rate-limit window has elapsed)…
    const sel = await pool.select({ providerId: "anthropic-subscription" });
    expect(sel?.id).toBe("solo");

    // …so availability must report it, or the router's failover gate
    // (rows.some(r => r.healthy > 0)) refuses a respawn the pool would serve.
    const sub = bridge
      ?.describe()
      .claude?.find((p) => p.providerId === "anthropic-subscription");
    expect(sub).toMatchObject({ total: 1, enabled: 1, healthy: 1 });
  });

  it("still reports 0 healthy for future rate-limits, invalid, needs-reauth, and disabled accounts", () => {
    const future = Date.now() + 3_600_000;
    const accounts = {
      "anthropic-subscription:rl": account("rl", {
        health: "rate-limited",
        healthDetail: { until: future },
      }),
      "anthropic-subscription:bad": account("bad", { health: "invalid" }),
      "anthropic-subscription:reauth": account("reauth", {
        health: "needs-reauth",
      }),
      "anthropic-subscription:off": account("off", { enabled: false }),
    };
    installCodingAgentSelectorBridge(poolOf(accounts));
    const sub = getCodingAgentSelectorBridge()
      ?.describe()
      .claude?.find((p) => p.providerId === "anthropic-subscription");
    expect(sub).toMatchObject({ total: 4, enabled: 3, healthy: 0 });
  });

  it("isAccountSelectableNow mirrors the eligibility gate's health rules", () => {
    const now = 1_000_000;
    expect(isAccountSelectableNow(account("x"), now)).toBe(true);
    expect(
      isAccountSelectableNow(
        account("x", {
          health: "rate-limited",
          healthDetail: { until: now },
        }),
        now,
      ),
    ).toBe(false);
    expect(
      isAccountSelectableNow(
        account("x", {
          health: "rate-limited",
          healthDetail: { until: now - 1 },
        }),
        now,
      ),
    ).toBe(true);
    expect(
      isAccountSelectableNow(
        account("x", {
          health: "rate-limited",
          healthDetail: { until: now + 1 },
        }),
        now,
      ),
    ).toBe(false);
    // rate-limited with no reset timestamp never self-readmits.
    expect(
      isAccountSelectableNow(account("x", { health: "rate-limited" }), now),
    ).toBe(false);
    expect(
      isAccountSelectableNow(account("x", { health: "invalid" }), now),
    ).toBe(false);
    expect(
      isAccountSelectableNow(account("x", { health: "needs-reauth" }), now),
    ).toBe(false);
  });
});

describe("account health mutation lifecycle", () => {
  it("persists explicit failure states, recovery, metadata, and reprobe readiness", async () => {
    const accounts: Record<string, LinkedAccountConfig> = {
      "anthropic-subscription:a": account("a", {
        usage: { refreshedAt: 1, resetsAt: Date.now() + 120_000 },
      }),
      "anthropic-subscription:b": account("b", {
        health: "rate-limited",
        healthDetail: { until: Date.now() - 1 },
      }),
      "anthropic-subscription:c": account("c", {
        health: "rate-limited",
        healthDetail: { until: Date.now() + 120_000 },
      }),
    };
    const deleted: string[] = [];
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async (next) => {
        accounts[`${next.providerId}:${next.id}`] = next;
      },
      deleteAccount: async (providerId, accountId) => {
        deleted.push(`${providerId}:${accountId}`);
      },
    });

    await pool.markRateLimited("a", Date.now() + 1_000, "provider quota", {
      providerId: "anthropic-subscription",
    });
    expect(accounts["anthropic-subscription:a"]?.healthDetail).toMatchObject({
      lastError: "provider quota",
      until: expect.any(Number),
    });

    await pool.markNeedsReauth("a", "expired", {
      providerId: "anthropic-subscription",
    });
    expect(accounts["anthropic-subscription:a"]?.health).toBe("needs-reauth");
    await pool.markNeedsReauth("a", "refresh token revoked", {
      providerId: "anthropic-subscription",
    });
    expect(accounts["anthropic-subscription:a"]?.healthDetail?.lastError).toBe(
      "refresh token revoked",
    );

    await pool.markInvalid("a", "revoked", {
      providerId: "anthropic-subscription",
    });
    expect(accounts["anthropic-subscription:a"]?.health).toBe("invalid");

    await pool.markHealthy("a", { providerId: "anthropic-subscription" });
    expect(accounts["anthropic-subscription:a"]?.health).toBe("ok");
    expect(accounts["anthropic-subscription:a"]?.healthDetail).toBeUndefined();

    const inserted = account("inserted", { priority: 4 });
    await pool.upsert(inserted);
    expect(pool.get("inserted", "anthropic-subscription")).toEqual(inserted);
    expect(pool.list("anthropic-subscription")).toHaveLength(4);

    await pool.deleteMetadata("anthropic-subscription", "inserted");
    expect(deleted).toEqual(["anthropic-subscription:inserted"]);
    expect(await pool.reprobeFlagged()).toContain("b");
    expect(await pool.reprobeFlagged()).not.toContain("c");
  });

  it("leaves persistence untouched for missing accounts and unsupported probes", async () => {
    const accounts: Record<string, LinkedAccountConfig> = {
      "openai-api:direct": {
        ...account("direct"),
        providerId: "openai-api",
        source: "api-key",
      },
    };
    const writes: LinkedAccountConfig[] = [];
    const pool = new AccountPool({
      readAccounts: () => accounts,
      writeAccount: async (next) => {
        writes.push(next);
      },
    });

    await pool.recordCall("missing", { ok: false });
    await pool.refreshUsage("missing", "token");
    await pool.markRateLimited("missing", Date.now());
    await pool.markNeedsReauth("missing");
    await pool.markInvalid("missing");
    await pool.markHealthy("missing");
    await pool.refreshUsage("direct", "token", { providerId: "openai-api" });
    await pool.markHealthy("direct", { providerId: "openai-api" });
    await pool.deleteMetadata("openai-api", "direct");

    expect(writes).toEqual([]);
    expect(pool.list()).toEqual([accounts["openai-api:direct"]]);
    expect(pool.list("anthropic-subscription")).toEqual([]);
    expect(pool.get("missing")).toBeNull();
  });
});

describe("configured provider selection", () => {
  it("normalizes provider strategies and route-scoped account pins", () => {
    configureDefaultAccountPoolSelection({
      accountStrategies: {
        "anthropic-api": "reset-soonest",
        "openai-api": "invalid",
      },
      serviceRouting: {
        llmText: {
          backend: "anthropic",
          strategy: "quota-aware",
          accountIds: [" primary ", "", "fallback"],
        },
      },
    });

    expect(selectionForProvider("anthropic-api")).toEqual({
      strategy: "quota-aware",
      accountIds: ["primary", "fallback"],
    });
    expect(selectionForProvider("anthropic-subscription")).toEqual({
      strategy: "quota-aware",
      accountIds: ["primary", "fallback"],
    });
    expect(selectionForProvider("openai-api")).toEqual({
      strategy: undefined,
      accountIds: undefined,
    });

    configureDefaultAccountPoolSelection({
      serviceRouting: {
        llmText: {
          backend: "openai",
          accountId: " codex-primary ",
          strategy: "round-robin",
        },
      },
    });
    expect(selectionForProvider("openai-codex")).toEqual({
      strategy: "round-robin",
      accountIds: ["codex-primary"],
    });
  });
});
