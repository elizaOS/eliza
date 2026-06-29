/**
 * Regression tests for the Tier-2 pending-charge sweep cron route (#9899).
 * Asserts cron-secret enforcement, the optimistic-billing-disabled no-op, and
 * that an authorized run delegates to sweepStalePendingInferenceCharges.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let optimisticEnabled = false;
const sweep = mock(async () => ({
  scanned: 3,
  settled: 2,
  uncollectedOrStale: 1,
  skippedYoung: 0,
}));

mock.module("@/lib/services/inference-billing-fast-path", () => ({
  isOptimisticBillingEnabled: () => optimisticEnabled,
  sweepStalePendingInferenceCharges: sweep,
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
  });

  test("runs the sweep and returns stats when optimistic billing is enabled", async () => {
    optimisticEnabled = true;
    const res = await call({ secret: "cron-secret" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      scanned: 3,
      settled: 2,
      uncollectedOrStale: 1,
      skippedYoung: 0,
    });
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
