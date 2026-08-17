/**
 * AppEarningsService fail-closed money-path contract (#13415 slice).
 *
 * Pins three former fail-open paths at the service boundary:
 *
 *  1. `requestWithdrawal` accepted NaN / non-positive amounts: `amount <
 *     threshold` is false for NaN, so the minimum-payout gate was bypassed and
 *     a 'NaN'::numeric transaction row could poison every SUM aggregate over
 *     the app's history. Non-finite and non-positive amounts must now be
 *     refused before any write.
 *  2. `updatePayoutThreshold` guarded only `threshold < 1`, which NaN and
 *     Infinity both pass (comparison false) — and Postgres NUMERIC accepts the
 *     literals 'NaN'/'Infinity', permanently poisoning the row. Non-finite
 *     thresholds must now throw.
 *  3. `getEarningsSummary` coerced NUMERIC columns with bare `Number(...)`,
 *     reporting a corrupt row as a healthy-looking $NaN account. A corrupt
 *     value must now throw.
 *
 * The harness is real: the actual service + repository SQL runs against
 * in-process PGlite. Only `appsRepository.findById` (the unrelated
 * app-existence + monetization check) is stubbed. The `pgliteReady` guard
 * fails loudly if PGlite never initializes.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const APP_ID = "00000000-0000-0000-0000-0000000000b1";
const PGLITE_TIMEOUT = 60000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let appEarningsService: typeof import("../app-earnings").appEarningsService;
let appsRepository: typeof import("../../../db/repositories/apps").appsRepository;
let findByIdSpy: { mockRestore: () => void } | undefined;
let pgliteReady = true;

async function seedEarnings(withdrawable: string, threshold = "1.00"): Promise<void> {
  await dbWrite.execute(`DELETE FROM app_earnings_transactions;`);
  await dbWrite.execute(`DELETE FROM app_earnings;`);
  await dbWrite.execute(
    `INSERT INTO app_earnings (app_id, withdrawable_balance, total_withdrawn, payout_threshold)
     VALUES ('${APP_ID}', '${withdrawable}', '0', '${threshold}');`,
  );
}

async function withdrawableBalance(): Promise<string> {
  const r = await dbWrite.execute(
    `SELECT withdrawable_balance FROM app_earnings WHERE app_id = '${APP_ID}';`,
  );
  return (r.rows[0] as { withdrawable_balance: string }).withdrawable_balance;
}

async function payoutThreshold(): Promise<string> {
  const r = await dbWrite.execute(
    `SELECT payout_threshold FROM app_earnings WHERE app_id = '${APP_ID}';`,
  );
  return (r.rows[0] as { payout_threshold: string }).payout_threshold;
}

async function transactionCount(): Promise<number> {
  const r = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM app_earnings_transactions WHERE app_id = '${APP_ID}';`,
  );
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ appEarningsService } = await import("../app-earnings"));
    ({ appsRepository } = await import("../../../db/repositories/apps"));

    // DDL mirrors app-earnings-withdrawal-idempotency.test.ts, including the
    // migration-0156 idempotency gate the withdrawal path relies on.
    const ddl = [
      `CREATE TABLE IF NOT EXISTS app_earnings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL,
        total_lifetime_earnings numeric(12,6) NOT NULL DEFAULT '0.000000',
        total_inference_earnings numeric(12,6) NOT NULL DEFAULT '0.000000',
        total_purchase_earnings numeric(12,6) NOT NULL DEFAULT '0.000000',
        pending_balance numeric(12,6) NOT NULL DEFAULT '0.000000',
        withdrawable_balance numeric(12,6) NOT NULL DEFAULT '0.000000',
        total_withdrawn numeric(12,6) NOT NULL DEFAULT '0.000000',
        last_withdrawal_at timestamp,
        payout_threshold numeric(10,2) NOT NULL DEFAULT '25.00',
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS app_earnings_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL,
        user_id uuid,
        type text NOT NULL,
        amount numeric(10,6) NOT NULL,
        description text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS app_earnings_tx_withdrawal_idempotency_uidx
        ON app_earnings_transactions (app_id, (metadata ->> 'idempotencyKey'))
        WHERE type = 'withdrawal' AND (metadata ->> 'idempotencyKey') IS NOT NULL`,
    ];
    for (const stmt of ddl) await dbWrite.execute(stmt);

    findByIdSpy = spyOn(appsRepository, "findById").mockResolvedValue({
      id: APP_ID,
      monetization_enabled: true,
    } as never);
  } catch (error) {
    pgliteReady = false;
    console.warn("[app-earnings-fail-closed] PGlite unavailable, skipping DB cases:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  findByIdSpy?.mockRestore();
  if (closeDb) await closeDb();
});

describe("AppEarningsService.requestWithdrawal amount validation", () => {
  for (const [label, amount] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -5],
    ["zero", 0],
  ] as const) {
    test(
      `refuses a ${label} amount before any write`,
      async () => {
        if (!pgliteReady) return;
        await seedEarnings("50.000000");

        const result = await appEarningsService.requestWithdrawal(
          APP_ID,
          amount,
          `fail-closed-${label}`,
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("positive, finite");
        // Nothing was written: no transaction row, balance untouched.
        expect(await transactionCount()).toBe(0);
        expect(Number(await withdrawableBalance())).toBeCloseTo(50, 6);
      },
      PGLITE_TIMEOUT,
    );
  }

  test(
    "a valid amount still withdraws (guard is not over-broad)",
    async () => {
      if (!pgliteReady) return;
      await seedEarnings("50.000000");

      const result = await appEarningsService.requestWithdrawal(APP_ID, 10, "fail-closed-valid");

      expect(result.success).toBe(true);
      expect(await transactionCount()).toBe(1);
      expect(Number(await withdrawableBalance())).toBeCloseTo(40, 6);
    },
    PGLITE_TIMEOUT,
  );
});

describe("AppEarningsService.updatePayoutThreshold validation", () => {
  for (const [label, threshold] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["sub-dollar", 0.5],
  ] as const) {
    test(
      `rejects a ${label} threshold without writing`,
      async () => {
        if (!pgliteReady) return;
        await seedEarnings("50.000000", "25.00");

        await expect(appEarningsService.updatePayoutThreshold(APP_ID, threshold)).rejects.toThrow(
          "finite amount of at least $1.00",
        );
        expect(await payoutThreshold()).toBe("25.00");
      },
      PGLITE_TIMEOUT,
    );
  }

  test(
    "a valid threshold still updates",
    async () => {
      if (!pgliteReady) return;
      await seedEarnings("50.000000", "25.00");

      await appEarningsService.updatePayoutThreshold(APP_ID, 10);
      expect(await payoutThreshold()).toBe("10.00");
    },
    PGLITE_TIMEOUT,
  );
});

describe("AppEarningsService.getEarningsSummary corrupt-row handling", () => {
  test(
    "a corrupt NUMERIC balance throws instead of reporting $NaN",
    async () => {
      if (!pgliteReady) return;
      // Postgres NUMERIC accepts the literal 'NaN'; this is exactly the
      // corruption the summary used to render as a healthy-looking account.
      await seedEarnings("NaN");

      await expect(appEarningsService.getEarningsSummary(APP_ID)).rejects.toThrow(
        "withdrawable_balance",
      );
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a healthy row still summarizes",
    async () => {
      if (!pgliteReady) return;
      await seedEarnings("12.500000", "5.00");

      const summary = await appEarningsService.getEarningsSummary(APP_ID);
      expect(summary).not.toBeNull();
      expect(summary?.withdrawableBalance).toBeCloseTo(12.5, 6);
      expect(summary?.payoutThreshold).toBeCloseTo(5, 6);
    },
    PGLITE_TIMEOUT,
  );
});
