/** Verifies the provisional 0268 receipt migration against real PostgreSQL semantics in PGlite. */

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("./0268_app_reservation_settlement_authority.sql", import.meta.url);
const migrationSql = await Bun.file(migrationUrl).text();

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const reservationId = "00000000-0000-4000-8000-000000000010";
const adjustmentId = "00000000-0000-4000-8000-000000000011";
const appId = "00000000-0000-4000-8000-000000000020";
const userId = "00000000-0000-4000-8000-000000000021";
const creatorId = "00000000-0000-4000-8000-000000000022";
const creatorLedgerId = "00000000-0000-4000-8000-000000000030";
const appProjectionId = "00000000-0000-4000-8000-000000000031";
const monetizedReservationId = "00000000-0000-4000-8000-000000000032";
const monetizedAdjustmentId = "00000000-0000-4000-8000-000000000033";
const historicalExactId = "00000000-0000-4000-8000-000000000040";
const historicalExactAdjustmentId = "00000000-0000-4000-8000-000000000041";
const historicalQuarantineId = "00000000-0000-4000-8000-000000000042";
const rollingCutoverId = "00000000-0000-4000-8000-000000000043";

async function prerequisiteDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE apps (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      amount numeric(16,6) NOT NULL,
      type text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}',
      stripe_payment_intent_id text,
      settled_at timestamptz,
      CONSTRAINT credit_transactions_id_organization_unique UNIQUE (id, organization_id)
    );
    CREATE TABLE redeemable_earnings_ledger (
      id uuid PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      amount numeric(16,4), earnings_source text,
      source_id uuid, entry_type text, metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE app_earnings_transactions (
      id uuid PRIMARY KEY, app_id uuid REFERENCES apps(id) ON DELETE CASCADE,
      user_id uuid, type text,
      amount numeric(16,6), metadata jsonb NOT NULL DEFAULT '{}'
    );
    INSERT INTO organizations(id) VALUES ('${organizationId}'), ('${otherOrganizationId}');
    INSERT INTO users(id) VALUES ('${creatorId}');
    INSERT INTO apps(id) VALUES ('${appId}');
    INSERT INTO credit_transactions(id, organization_id, amount, type, metadata)
      VALUES (
        '${reservationId}', '${organizationId}', -0.03, 'debit',
        '{"type":"app_chat_reservation","settlement_marker":"app_chat_reservation_v1","appId":"${appId}","userId":"${userId}","reserved_amount":0.03}'
      );
    INSERT INTO credit_transactions(
      id, organization_id, amount, type, stripe_payment_intent_id
    ) VALUES (
      '${adjustmentId}', '${organizationId}', 0.02, 'refund',
      'reconcile-refund:${reservationId}'
    );
    INSERT INTO credit_transactions(id, organization_id, amount, type, metadata)
      VALUES (
        '${historicalExactId}', '${organizationId}', -0.03, 'debit',
        '{"type":"app_chat_reservation","settlement_marker":"app_chat_reservation_v1","appId":"${appId}","userId":"${userId}","reserved_amount":0.03,"markupPercentage":0}'
      ), (
        '${historicalQuarantineId}', '${organizationId}', -0.06, 'debit',
        '{"type":"app_chat_reservation","settlement_marker":"app_chat_reservation_v1","appId":"${appId}","userId":"${userId}","creatorUserId":"${creatorId}","reserved_amount":0.03,"markupPercentage":100}'
      );
    UPDATE credit_transactions SET settled_at = now()
      WHERE id IN ('${historicalExactId}', '${historicalQuarantineId}');
    INSERT INTO credit_transactions(
      id, organization_id, amount, type, stripe_payment_intent_id, metadata
    ) VALUES (
      '${historicalExactAdjustmentId}', '${organizationId}', 0.02, 'refund',
      'reconcile-refund:${historicalExactId}',
      '{"reservation_transaction_id":"${historicalExactId}","estimatedBaseCost":0.03,"actualBaseCost":0.01,"markupPercentage":0}'
    );
  `);
  return db;
}

describe("0268 app reservation settlement authority", () => {
  test("creates exact tenant fences and immutable receipts", async () => {
    const db = await prerequisiteDb();
    try {
      await db.exec(migrationSql);
      await db.exec(`
        INSERT INTO app_reservation_settlements (
          reservation_transaction_id, organization_id, app_id, user_id,
          terminal_source, outcome, reserved_base_cost, actual_base_cost,
          markup_percentage, reserved_total_cost, actual_total_cost,
          organization_adjustment, creator_adjustment, platform_adjustment,
          credit_transaction_id
        ) VALUES (
          '${reservationId}', '${organizationId}', '${appId}', '${userId}',
          'provider', 'refund', 0.03, 0.01, 0, 0.03, 0.01, -0.02, 0, -0.02,
          '${adjustmentId}'
        );
      `);
      await expect(
        db.exec(
          "UPDATE app_reservation_settlements SET actual_base_cost = 0.02 WHERE reservation_transaction_id = '" +
            reservationId +
            "'",
        ),
      ).rejects.toThrow("immutable");
      await expect(db.exec("TRUNCATE app_reservation_settlements")).rejects.toThrow("immutable");
      await expect(
        db.exec(`UPDATE credit_transactions SET amount = -0.04 WHERE id = '${reservationId}'`),
      ).rejects.toThrow("facts are immutable");
      await expect(
        db.exec(
          `UPDATE credit_transactions SET metadata = metadata || '{"appId":"${userId}"}' WHERE id = '${reservationId}'`,
        ),
      ).rejects.toThrow("facts are immutable");
      await db.exec(
        `UPDATE credit_transactions SET settled_at = now() WHERE id = '${reservationId}'`,
      );
      await db.exec(`
        INSERT INTO credit_transactions(id, organization_id, amount, type, metadata)
        VALUES (
          '${rollingCutoverId}', '${organizationId}', -0.06, 'debit',
          '{"type":"app_chat_reservation","settlement_marker":"app_chat_reservation_v1","appId":"${appId}","userId":"${userId}","creatorUserId":"${creatorId}","reserved_amount":0.03}'
        );
        UPDATE credit_transactions SET settled_at = now() WHERE id = '${rollingCutoverId}';
      `);

      const exactBackfill = await db.query<{ actual_base_cost: string; outcome: string }>(`
        SELECT actual_base_cost, outcome FROM app_reservation_settlements
        WHERE reservation_transaction_id = '${historicalExactId}'
      `);
      expect(exactBackfill.rows).toEqual([{ actual_base_cost: "0.010000", outcome: "refund" }]);
      const quarantine = await db.query<{ reason: string }>(`
        SELECT reason FROM app_reservation_settlement_quarantines
        WHERE reservation_transaction_id = '${historicalQuarantineId}'
      `);
      expect(quarantine.rows).toEqual([{ reason: "pre_authority_economics_unreconstructable" }]);
      await expect(
        db.exec(`
          INSERT INTO app_reservation_settlements (
            reservation_transaction_id, organization_id, app_id, user_id, creator_user_id,
            terminal_source, outcome, reserved_base_cost, actual_base_cost,
            markup_percentage, reserved_total_cost, actual_total_cost,
            organization_adjustment, creator_adjustment, platform_adjustment
          ) VALUES (
            '${historicalQuarantineId}', '${organizationId}', '${appId}', '${userId}',
            '${creatorId}', 'provider', 'none', 0.03, 0.03, 100, 0.06, 0.06, 0, 0, 0
          )
        `),
      ).rejects.toThrow("does not match immutable reservation facts");
      const quarantineAuthority = await db.query<{ quarantines: number; receipts: number }>(`
        SELECT
          (SELECT count(*)::int FROM app_reservation_settlement_quarantines
            WHERE reservation_transaction_id = '${historicalQuarantineId}') AS quarantines,
          (SELECT count(*)::int FROM app_reservation_settlements
            WHERE reservation_transaction_id = '${historicalQuarantineId}') AS receipts
      `);
      expect(quarantineAuthority.rows).toEqual([{ quarantines: 1, receipts: 0 }]);
      const rollingQuarantine = await db.query<{ reservation_transaction_id: string }>(`
        SELECT reservation_transaction_id FROM app_reservation_settlement_quarantines
        WHERE reservation_transaction_id = '${rollingCutoverId}'
      `);
      expect(rollingQuarantine.rows).toEqual([{ reservation_transaction_id: rollingCutoverId }]);
      await expect(
        db.exec(
          `DELETE FROM app_reservation_settlement_quarantines WHERE reservation_transaction_id = '${historicalQuarantineId}'`,
        ),
      ).rejects.toThrow("immutable");

      const constraints = await db.query<{ conname: string }>(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'app_reservation_settlements'::regclass
        ORDER BY conname
      `);
      expect(constraints.rows.map((row) => row.conname)).toEqual(
        expect.arrayContaining([
          "app_reservation_settlements_adjustment_tenant_fk",
          "app_reservation_settlements_economics_check",
          "app_reservation_settlements_organization_fk",
          "app_reservation_settlements_outcome_check",
          "app_reservation_settlements_pkey",
          "app_reservation_settlements_reservation_tenant_fk",
          "app_reservation_settlements_source_check",
        ]),
      );
    } finally {
      await db.close();
    }
  });

  test("freezes every referenced ledger projection but leaves unrelated rows mutable", async () => {
    const db = await prerequisiteDb();
    try {
      await db.exec(migrationSql);
      await db.exec(`
        INSERT INTO credit_transactions(id, organization_id, amount, type, metadata)
        VALUES (
          '${monetizedReservationId}', '${organizationId}', -0.06, 'debit',
          '{"type":"app_chat_reservation","settlement_marker":"app_chat_reservation_v1","appId":"${appId}","userId":"${userId}","creatorUserId":"${creatorId}","reserved_amount":0.03}'
        );
        INSERT INTO credit_transactions(
          id, organization_id, amount, type, stripe_payment_intent_id, metadata
        ) VALUES (
          '${monetizedAdjustmentId}', '${organizationId}', 0.04, 'refund',
          'reconcile-refund:${monetizedReservationId}', '{"authority":"settlement"}'
        );
        INSERT INTO redeemable_earnings_ledger(
          id, user_id, amount, earnings_source, entry_type, metadata
        ) VALUES (
          '${creatorLedgerId}', '${creatorId}', -0.02, 'miniapp',
          'reconciliation_reduction', '{"authority":"settlement"}'
        );
        INSERT INTO app_earnings_transactions(id, app_id, user_id, type, amount, metadata)
        VALUES (
          '${appProjectionId}', '${appId}', '${userId}', 'inference_markup', -0.02,
          '{"redeemableLedgerEntryId":"${creatorLedgerId}","authority":"settlement"}'
        );
        INSERT INTO app_reservation_settlements (
          reservation_transaction_id, organization_id, app_id, user_id, creator_user_id,
          terminal_source, outcome, reserved_base_cost, actual_base_cost,
          markup_percentage, reserved_total_cost, actual_total_cost,
          organization_adjustment, creator_adjustment, platform_adjustment,
          credit_transaction_id, redeemable_ledger_entry_id, app_earnings_transaction_id
        ) VALUES (
          '${monetizedReservationId}', '${organizationId}', '${appId}', '${userId}', '${creatorId}',
          'provider', 'refund', 0.03, 0.01, 100, 0.06, 0.02, -0.04, -0.02, -0.02,
          '${monetizedAdjustmentId}', '${creatorLedgerId}', '${appProjectionId}'
        );
      `);

      await expect(
        db.exec(
          `UPDATE credit_transactions SET metadata = '{}' WHERE id = '${monetizedAdjustmentId}'`,
        ),
      ).rejects.toThrow("immutable");
      await expect(
        db.exec(
          `UPDATE redeemable_earnings_ledger SET amount = -0.01 WHERE id = '${creatorLedgerId}'`,
        ),
      ).rejects.toThrow("immutable");
      await expect(
        db.exec(
          `UPDATE app_earnings_transactions SET amount = -0.01 WHERE id = '${appProjectionId}'`,
        ),
      ).rejects.toThrow("immutable");
      await expect(
        db.exec(`DELETE FROM credit_transactions WHERE id = '${monetizedAdjustmentId}'`),
      ).rejects.toThrow();
      await expect(
        db.exec(`DELETE FROM redeemable_earnings_ledger WHERE id = '${creatorLedgerId}'`),
      ).rejects.toThrow();
      await expect(
        db.exec(`DELETE FROM app_earnings_transactions WHERE id = '${appProjectionId}'`),
      ).rejects.toThrow();
      await expect(db.exec("TRUNCATE credit_transactions")).rejects.toThrow();
      await expect(db.exec("TRUNCATE redeemable_earnings_ledger")).rejects.toThrow();
      await expect(db.exec("TRUNCATE app_earnings_transactions")).rejects.toThrow();

      await db.exec(`
        INSERT INTO redeemable_earnings_ledger(id, user_id, amount, earnings_source, entry_type)
        VALUES ('00000000-0000-4000-8000-000000000099', '${creatorId}', 1, 'miniapp', 'earning');
        UPDATE redeemable_earnings_ledger SET amount = 2
        WHERE id = '00000000-0000-4000-8000-000000000099';
      `);

      await db.exec(`DELETE FROM apps WHERE id = '${appId}'`);
      await db.exec(`DELETE FROM users WHERE id = '${creatorId}'`);
      const retainedReceipt = await db.query<{ app_earnings_transaction_id: string }>(`
        SELECT app_earnings_transaction_id, redeemable_ledger_entry_id
        FROM app_reservation_settlements
        WHERE reservation_transaction_id = '${monetizedReservationId}'
      `);
      expect(retainedReceipt.rows).toHaveLength(1);
      expect(
        await db.query(`SELECT id FROM app_earnings_transactions WHERE id = '${appProjectionId}'`),
      ).toMatchObject({ rows: [] });
      expect(
        await db.query(`SELECT id FROM redeemable_earnings_ledger WHERE id = '${creatorLedgerId}'`),
      ).toMatchObject({ rows: [] });
    } finally {
      await db.close();
    }
  });

  test("rejects forged quarantine authority for active or mismatched reservations", async () => {
    const db = await prerequisiteDb();
    const activeId = "00000000-0000-4000-8000-000000000050";
    const mismatchId = "00000000-0000-4000-8000-000000000051";
    const wrongTypeId = "00000000-0000-4000-8000-000000000052";
    const wrongMarkerId = "00000000-0000-4000-8000-000000000053";
    try {
      await db.exec(migrationSql);
      await db.exec(`
        INSERT INTO credit_transactions(id, organization_id, amount, type, metadata, settled_at)
        VALUES
          ('${activeId}', '${organizationId}', -0.03, 'debit',
           '{"type":"app_chat_reservation","settlement_marker":"app_chat_reservation_v1","appId":"${appId}","userId":"${userId}","reserved_amount":0.03}', NULL),
          ('${mismatchId}', '${organizationId}', -0.03, 'debit',
           '{"type":"app_chat_reservation","settlement_marker":"app_chat_reservation_v1","appId":"${appId}","userId":"${userId}","reserved_amount":0.03}', '2026-08-19T12:00:00Z'),
          ('${wrongTypeId}', '${organizationId}', -0.03, 'refund',
           '{"type":"app_chat_reservation","settlement_marker":"app_chat_reservation_v1","appId":"${appId}","userId":"${userId}","reserved_amount":0.03}', '2026-08-19T12:00:00Z'),
          ('${wrongMarkerId}', '${organizationId}', -0.03, 'debit',
           '{"type":"app_chat_reservation","settlement_marker":"wrong","appId":"${appId}","userId":"${userId}","reserved_amount":0.03}', '2026-08-19T12:00:00Z');
      `);
      const quarantineInsert = (reservation: string, app: string, time: string) =>
        db.exec(`
          INSERT INTO app_reservation_settlement_quarantines(
            reservation_transaction_id, organization_id, app_id, user_id, reason, quarantined_at
          ) VALUES (
            '${reservation}', '${organizationId}', '${app}', '${userId}',
            'pre_authority_economics_unreconstructable', '${time}'
          )
        `);
      await expect(quarantineInsert(activeId, appId, "2026-08-19T12:00:00Z")).rejects.toThrow(
        "does not match",
      );
      await expect(quarantineInsert(mismatchId, userId, "2026-08-19T12:00:00Z")).rejects.toThrow(
        "does not match",
      );
      await expect(quarantineInsert(mismatchId, appId, "2026-08-19T12:00:01Z")).rejects.toThrow(
        "does not match",
      );
      await expect(quarantineInsert(wrongTypeId, appId, "2026-08-19T12:00:00Z")).rejects.toThrow(
        "does not match",
      );
      await expect(quarantineInsert(wrongMarkerId, appId, "2026-08-19T12:00:00Z")).rejects.toThrow(
        "does not match",
      );
    } finally {
      await db.close();
    }
  });

  test("rejects cross-tenant receipts", async () => {
    const db = await prerequisiteDb();
    try {
      await db.exec(migrationSql);
      await expect(
        db.exec(`
          INSERT INTO app_reservation_settlements (
            reservation_transaction_id, organization_id, app_id, user_id,
            terminal_source, outcome, reserved_base_cost, actual_base_cost,
            markup_percentage, reserved_total_cost, actual_total_cost,
            organization_adjustment, creator_adjustment, platform_adjustment
          ) VALUES (
            '${reservationId}', '${otherOrganizationId}', '${appId}', '${userId}',
            'provider', 'none', 0.03, 0.03, 0, 0.03, 0.03, 0, 0, 0
          );
        `),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  test("fails loudly on replay and partial collision", async () => {
    const replayDb = await prerequisiteDb();
    try {
      await replayDb.exec(migrationSql);
      await expect(replayDb.exec(migrationSql)).rejects.toThrow();
    } finally {
      await replayDb.close();
    }

    const partialDb = await prerequisiteDb();
    try {
      await partialDb.exec("CREATE TABLE app_reservation_settlements (wrong text)");
      await expect(partialDb.exec(migrationSql)).rejects.toThrow();
      const columns = await partialDb.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'app_reservation_settlements'
      `);
      expect(columns.rows.map((row) => row.column_name)).toEqual(["wrong"]);
    } finally {
      await partialDb.close();
    }
  });
});
