import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LinkedAccountConfig } from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AccountPool } from "./account-pool";
import type { AccountPoolConsumerUsageBreakdown } from "./account-pool-consumer-metering";
import {
  __resetAccountPoolStatusForTests,
  getPublicAccountPoolStatus,
} from "./account-pool-status";

const totals = {
  requests: 4,
  tokens: 120,
  input_tokens: 80,
  output_tokens: 40,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 2,
  errors: 1,
  latencyMs: 900,
};

function usageBreakdown(day: string): AccountPoolConsumerUsageBreakdown {
  return {
    totals,
    byDay: { [day]: totals },
    byConsumer: { "consumer-private-id": totals },
    records: [],
  };
}

function fixtureAccount(
  now: number,
  weeklyPct: number,
  resetAt = now + 48 * 60 * 60_000,
): LinkedAccountConfig {
  return {
    id: "private-account-id",
    providerId: "anthropic-subscription",
    label: "owner-private@example.test",
    source: "oauth",
    enabled: true,
    priority: 77,
    createdAt: 1,
    health: "ok",
    usage: {
      sessionPct: 12,
      weeklyPct,
      refreshedAt: now,
      sessionResetsAt: now + 5 * 60 * 60_000,
      resetsAt: resetAt,
    } as unknown as LinkedAccountConfig["usage"],
  };
}

const cleanup: string[] = [];
afterEach(() => {
  __resetAccountPoolStatusForTests();
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("public account-pool status", () => {
  it("returns an allowlisted anonymous shape and no private pool or consumer data", async () => {
    const now = Date.UTC(2026, 6, 16, 4);
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-pool-status-"));
    cleanup.push(dir);
    const account = fixtureAccount(now, 25);
    const pool = new AccountPool({
      readAccounts: () => ({
        "anthropic-subscription:private-account-id": account,
      }),
      writeAccount: async () => {},
    });
    __resetAccountPoolStatusForTests({
      pool,
      now: () => now,
      stateDir: () => dir,
      queryConsumerUsage: async () => usageBreakdown("2026-07-16"),
    });

    const status = await getPublicAccountPoolStatus();
    expect(status).toMatchObject({
      pool: { accounts: 1, capacityPct: 100, selectableAccounts: 1 },
      fable: { leftPct: 75, ofPct: 100, source: "all-model weekly fallback" },
      publicEdge: { today: { requests: 4, tokens: 120 } },
      urgency: {
        burnRatePctPerHour: null,
        projectedDepletionIn: null,
        nextRefill: { account: "account-1", capacityAddedPct: 25 },
      },
    });
    expect(status.perAccount[0]).toMatchObject({
      name: "account-1",
      weeklyUsedPct: 25,
      weeklyHeadroomPct: 75,
      burnRatePctPerHour: null,
      exhaustionMessage: "at current burn: estimating",
    });

    const json = JSON.stringify(status);
    for (const secret of [
      "private-account-id",
      "owner-private@example.test",
      "consumer-private-id",
    ]) {
      expect(json).not.toContain(secret);
    }
    const forbiddenKeys = new Set([
      "id",
      "email",
      "label",
      "priority",
      "lease",
      "consumerId",
      "key",
      "keyPrefix",
      "resetAt",
      "resetsAt",
    ]);
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        expect(forbiddenKeys.has(key), `private field ${key}`).toBe(false);
        walk(child);
      }
    };
    walk(status);
  });

  it("excludes accounts with unknown usage from capacity denominators", async () => {
    const now = Date.UTC(2026, 6, 16, 4);
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-pool-status-"));
    cleanup.push(dir);
    const known = fixtureAccount(now, 25);
    known.usage = {
      ...known.usage,
      weeklyModelBuckets: { Fable: { pct: 25 } },
    } as LinkedAccountConfig["usage"];
    const { usage: _usage, ...unknownBase } = fixtureAccount(now, 0);
    const unknown: LinkedAccountConfig = {
      ...unknownBase,
      id: "unknown-account-id",
    };
    const unavailable: LinkedAccountConfig = {
      ...fixtureAccount(now, 0),
      id: "unavailable-account-id",
      health: "needs-reauth",
    };
    const pool = new AccountPool({
      readAccounts: () => ({
        "anthropic-subscription:private-account-id": known,
        "anthropic-subscription:unknown-account-id": unknown,
        "anthropic-subscription:unavailable-account-id": unavailable,
      }),
      writeAccount: async () => {},
    });
    __resetAccountPoolStatusForTests({
      pool,
      now: () => now,
      stateDir: () => dir,
      queryConsumerUsage: async () => usageBreakdown("2026-07-16"),
    });

    const status = await getPublicAccountPoolStatus();
    expect(status.pool.accounts).toBe(2);
    expect(status.fable).toMatchObject({ leftPct: 75, ofPct: 100 });
    expect(status.allModels).toEqual({ leftPct: 75, ofPct: 100 });
    expect(status.perAccount[0]?.weeklyResetIn).not.toBeNull();
  });

  it("persists snapshots and projects burn only after a same-window sample", async () => {
    let now = Date.UTC(2026, 6, 16, 4);
    let weeklyPct = 20;
    const resetAt = now + 48 * 60 * 60_000;
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-pool-status-"));
    cleanup.push(dir);
    const pool = new AccountPool({
      readAccounts: () => ({
        "anthropic-subscription:private-account-id": fixtureAccount(
          now,
          weeklyPct,
          resetAt,
        ),
      }),
      writeAccount: async () => {},
    });
    __resetAccountPoolStatusForTests({
      pool,
      now: () => now,
      stateDir: () => dir,
      cacheTtlMs: 0,
      queryConsumerUsage: async () => usageBreakdown("2026-07-16"),
    });

    expect(
      (await getPublicAccountPoolStatus()).urgency.burnRatePctPerHour,
    ).toBeNull();
    now += 60 * 60_000;
    weeklyPct = 30;
    const projected = await getPublicAccountPoolStatus();
    expect(projected.perAccount[0]?.burnRatePctPerHour).toBe(10);
    expect(projected.perAccount[0]?.burnSampleHours).toBe(1);
    expect(projected.urgency.burnRatePctPerHour).toBe(10);
    expect(projected.urgency.projectedDepletionIn).not.toBeNull();

    const snapshots = readFileSync(
      path.join(dir, "account-pool", "public-status-snapshots.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n");
    expect(snapshots).toHaveLength(2);
    expect(snapshots.join("\n")).not.toContain("private-account-id");
  });
});
