/**
 * Regression tests for the Tier-2 pending-charge sweep cron route (#9899).
 * Asserts cron-secret enforcement, the optimistic-billing-disabled no-op, and
 * that an authorized run sweeps BOTH backends (DB ledger + KV) every run so a
 * flag flip between admit-time and sweep-time can't orphan pending charges.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let optimisticEnabled = false;
const sweep = mock(async () => ({
  scanned: 3,
  settled: 2,
  uncollectedOrStale: 1,
  skippedYoung: 0,
}));
const sweepDb = mock(async () => ({
  scanned: 5,
  settled: 4,
  skipped: 1,
  batches: 1,
  gcDeleted: 2,
  capHit: false,
}));

mock.module("@/lib/services/inference-billing-fast-path", () => ({
  isOptimisticBillingEnabled: () => optimisticEnabled,
  sweepStalePendingInferenceCharges: sweep,
}));

mock.module("@/lib/services/inference-billing-ledger", () => ({
  sweepStalePendingInferenceChargesDb: sweepDb,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

const ENV = { CRON_SECRET: "cron-secret" } as Record<string, string>;

function call(opts: { secret?: string; env?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {};
  if (opts.secret) headers.authorization = `Bearer ${opts.secret}`;
  return app.fetch(
    new Request("https://api.example.test/", { method: "POST", headers }),
    opts.env ?? ENV,
  );
}

describe("sweep-inference-charges cron route", () => {
  beforeEach(() => {
    optimisticEnabled = false;
    sweep.mockClear();
    sweepDb.mockClear();
  });

  test("403 when no cron secret is configured", async () => {
    const res = await call({ secret: "cron-secret", env: {} });
    expect(res.status).toBe(403);
    expect(sweep).not.toHaveBeenCalled();
  });

  test("401 on an invalid cron secret", async () => {
    const res = await call({ secret: "wrong" });
    expect(res.status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });

  test("no-op (skipped) when optimistic billing is disabled", async () => {
    optimisticEnabled = false;
    const res = await call({ secret: "cron-secret" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      skipped: "optimistic_billing_disabled",
    });
    expect(sweep).not.toHaveBeenCalled();
    expect(sweepDb).not.toHaveBeenCalled();
  });

  test("sweeps BOTH backends and returns their stats when optimistic billing is enabled", async () => {
    optimisticEnabled = true;
    const res = await call({ secret: "cron-secret" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      db: {
        scanned: 5,
        settled: 4,
        skipped: 1,
        batches: 1,
        gcDeleted: 2,
        capHit: false,
      },
      kv: { scanned: 3, settled: 2, uncollectedOrStale: 1, skippedYoung: 0 },
    });
    // BOTH backends are swept every run (orphan-window closure), regardless of flag.
    expect(sweepDb).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
