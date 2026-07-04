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
 * The pool is driven through injected readAccounts/writeAccount; only
 * `recordCall`'s JSONL usage counter touches disk (a throwaway state dir).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCodingAgentSelectorBridge } from "@elizaos/core";
import type { LinkedAccountConfig } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountPool, isAccountSelectableNow } from "./account-pool";
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
