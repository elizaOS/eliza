/**
 * App-earnings withdrawal idempotency hardening (#10878).
 *
 * Before: `AppEarningsService.requestWithdrawal` deduped a withdrawal via a
 * SELECT-then-INSERT with no backing unique constraint, so two concurrent (or
 * client-retried) requests with the same `idempotencyKey` could both pass the
 * existence check and both debit `withdrawable_balance` → double withdrawal
 * (over-credited redeemable balance).
 *
 * After: a partial unique index on
 *   (app_id, metadata->>'idempotencyKey') WHERE type='withdrawal' AND key NOT NULL
 * (migration 0156) is the gate. The service INSERTs the withdrawal row and
 * debits the balance inside one write transaction; a concurrent/retried request
 * loses the insert (23505) only after the winner commits and then returns that
 * winner WITHOUT debiting, so the balance moves exactly once. Failed debits roll
 * the claim back, so retries never observe a phantom successful withdrawal.
 *
 * These run the REAL service against in-process PGlite (real SQL: the partial
 * unique index, the conditional-CAS debit, the JSONB idempotency lookup). Only
 * `appsRepository.findById` (an unrelated app-existence + monetization check over
 * the 185-column `apps` relational schema) is stubbed — the thing under test,
 * the withdrawal money path, is fully real. Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const APP_ID = "00000000-0000-0000-0000-0000000000a1";
const PGLITE_TIMEOUT = 60000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let appEarningsService: typeof import("../app-earnings").appEarningsService;
let appsRepository: typeof import("../../../db/repositories/apps").appsRepository;
let findByIdSpy: { mockRestore: () => void } | undefined;
let pgliteReady = true;

async function seedEarnings(withdrawable: string, threshold = "1.00") {
  await dbWrite.execute(`DELETE FROM app_earnings_transactions;`);
  await dbWrite.execute(`DELETE FROM app_earnings;`);
  await dbWrite.execute(
    `INSERT INTO app_earnings (app_id, withdrawable_balance, total_withdrawn, payout_threshold)
     VALUES ('${APP_ID}', '${withdrawable}', '0', '${threshold}');`,
  );
}

async function balance(): Promise<{ withdrawable: number; withdrawn: number }> {
  const r = await dbWrite.execute(
    `SELECT withdrawable_balance, total_withdrawn FROM app_earnings WHERE app_id = '${APP_ID}';`,
  );
  const row = r.rows[0] as {
    withdrawable_balance: string;
    total_withdrawn: string;
  };
  return {
    withdrawable: Number(row.withdrawable_balance),
    withdrawn: Number(row.total_withdrawn),
  };
}

async function withdrawalRowCount(key?: string): Promise<number> {
  const where = key
    ? `WHERE type = 'withdrawal' AND metadata->>'idempotencyKey' = '${key}'`
    : `WHERE type = 'withdrawal'`;
  const r = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM app_earnings_transactions ${where};`,
  );
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ appEarningsService } = await import("../app-earnings"));
    ({ appsRepository } = await import("../../../db/repositories/apps"));

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
      // The migration-0156 idempotency gate.
      `CREATE UNIQUE INDEX IF NOT EXISTS app_earnings_tx_withdrawal_idempotency_uidx
        ON app_earnings_transactions (app_id, (metadata ->> 'idempotencyKey'))
        WHERE type = 'withdrawal' AND (metadata ->> 'idempotencyKey') IS NOT NULL`,
    ];
    for (const stmt of ddl) await dbWrite.execute(stmt);

    // Stub the unrelated app-existence + monetization lookup (real earnings SQL
    // stays live). Every appId resolves to a monetization-enabled app.
    findByIdSpy = spyOn(appsRepository, "findById").mockResolvedValue({
      id: APP_ID,
      monetization_enabled: true,
    } as never);
  } catch (error) {
    pgliteReady = false;
    console.warn(
      "[app-earnings-withdrawal-idempotency] PGlite unavailable, skipping DB cases:",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  findByIdSpy?.mockRestore();
  if (closeDb) await closeDb();
});

afterEach(async () => {
  if (pgliteReady) await dbWrite.execute(`DELETE FROM app_earnings_transactions;`);
});

describe("requestWithdrawal idempotency (#10878)", () => {
  test(
    "two concurrent requests with the same key debit the balance exactly once",
    async () => {
      if (!pgliteReady) return;
      await seedEarnings("100");

      const [a, b] = await Promise.all([
        appEarningsService.requestWithdrawal(APP_ID, 30, "wd-key-concurrent"),
        appEarningsService.requestWithdrawal(APP_ID, 30, "wd-key-concurrent"),
      ]);

      // Exactly one withdrawal row exists for the key (the unique index gate).
      expect(await withdrawalRowCount("wd-key-concurrent")).toBe(1);
      // The balance moved once, not twice.
      const bal = await balance();
      expect(bal.withdrawable).toBeCloseTo(70, 6);
      expect(bal.withdrawn).toBeCloseTo(30, 6);
      // At least one call succeeded; neither invented a second debit.
      expect(a.success || b.success).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a sequential retry with the same key is idempotent (no second debit)",
    async () => {
      if (!pgliteReady) return;
      await seedEarnings("100");

      const first = await appEarningsService.requestWithdrawal(APP_ID, 40, "wd-key-retry");
      const second = await appEarningsService.requestWithdrawal(APP_ID, 40, "wd-key-retry");

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      // Same transaction returned; balance debited only once.
      expect(second.transactionId).toBe(first.transactionId);
      expect(await withdrawalRowCount("wd-key-retry")).toBe(1);
      expect((await balance()).withdrawable).toBeCloseTo(60, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "distinct keys each debit (idempotency is per-key, not a blanket lock)",
    async () => {
      if (!pgliteReady) return;
      await seedEarnings("100");

      await appEarningsService.requestWithdrawal(APP_ID, 20, "wd-key-A");
      await appEarningsService.requestWithdrawal(APP_ID, 25, "wd-key-B");

      expect(await withdrawalRowCount()).toBe(2);
      expect((await balance()).withdrawable).toBeCloseTo(55, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a failed debit releases the claim so a later legitimate retry can proceed",
    async () => {
      if (!pgliteReady) return;
      await seedEarnings("10"); // less than the requested amount

      const failed = await appEarningsService.requestWithdrawal(APP_ID, 50, "wd-key-topup");
      expect(failed.success).toBe(false);
      // Claim released — no phantom row, key is free.
      expect(await withdrawalRowCount("wd-key-topup")).toBe(0);
      expect((await balance()).withdrawable).toBeCloseTo(10, 6);

      // Owner tops up; the SAME key must now be usable (not permanently burned).
      await dbWrite.execute(
        `UPDATE app_earnings SET withdrawable_balance = '100' WHERE app_id = '${APP_ID}';`,
      );
      const retry = await appEarningsService.requestWithdrawal(APP_ID, 50, "wd-key-topup");
      expect(retry.success).toBe(true);
      expect(await withdrawalRowCount("wd-key-topup")).toBe(1);
      expect((await balance()).withdrawable).toBeCloseTo(50, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "concurrent failed debits with the same key do not report a phantom success",
    async () => {
      if (!pgliteReady) return;
      await seedEarnings("10"); // less than the requested amount

      const [a, b] = await Promise.all([
        appEarningsService.requestWithdrawal(APP_ID, 50, "wd-key-fail-concurrent"),
        appEarningsService.requestWithdrawal(APP_ID, 50, "wd-key-fail-concurrent"),
      ]);

      expect(a.success).toBe(false);
      expect(b.success).toBe(false);
      expect(await withdrawalRowCount("wd-key-fail-concurrent")).toBe(0);
      const bal = await balance();
      expect(bal.withdrawable).toBeCloseTo(10, 6);
      expect(bal.withdrawn).toBeCloseTo(0, 6);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the DB partial unique index itself rejects a duplicate withdrawal insert",
    async () => {
      if (!pgliteReady) return;
      await seedEarnings("100");
      const insert = (k: string | null, type = "withdrawal") => {
        const meta = k === null ? "{}" : `{"idempotencyKey":"${k}"}`;
        return dbWrite.execute(
          `INSERT INTO app_earnings_transactions (app_id, type, amount, metadata)
           VALUES ('${APP_ID}', '${type}', '-5', '${meta}'::jsonb);`,
        );
      };
      const threw = async (p: Promise<unknown>) => {
        try {
          await p;
          return false;
        } catch {
          return true;
        }
      };

      await insert("dup-key");
      // Second withdrawal with the same key → unique violation.
      expect(await threw(insert("dup-key"))).toBe(true);
      // A DIFFERENT type with the same key is allowed (partial predicate).
      expect(await threw(insert("dup-key", "inference_markup"))).toBe(false);
      // A withdrawal with NO key is allowed (partial predicate excludes NULLs);
      // two of them do not collide.
      expect(await threw(insert(null))).toBe(false);
      expect(await threw(insert(null))).toBe(false);
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If pushSchema/PGlite ever fails to init, the DB-dependent tests above
// early-return; this turns that silent no-op into a hard CI failure so a
// money-path proof can never masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
