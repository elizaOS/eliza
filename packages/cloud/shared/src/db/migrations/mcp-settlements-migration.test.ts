/** Applies migration 0343 (mcp_settlements) to real PGlite for receipt-constraint proof (#27992). */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const databases: PGlite[] = [];
const migration = await readFile(new URL("./0376_mcp_settlements.sql", import.meta.url), "utf8");

const ORG = "11111111-1111-1111-1111-111111111111";
const MCP = "22222222-2222-2222-2222-222222222222";
const DEBIT = "33333333-3333-3333-3333-333333333333";

/**
 * The migration's foreign keys reference credit_transactions, user_mcps,
 * organizations, and mcp_usage; only the columns those constraints and the
 * sweep indexes touch are modelled, exactly as 0255 models crypto_payments.
 */
async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE user_mcps (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (
      id uuid NOT NULL,
      organization_id uuid NOT NULL,
      type text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id)
    );
    CREATE TABLE mcp_usage (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    INSERT INTO organizations (id) VALUES ('${ORG}');
    INSERT INTO user_mcps (id) VALUES ('${MCP}');
    INSERT INTO credit_transactions (id, organization_id, type, metadata)
      VALUES ('${DEBIT}', '${ORG}', 'debit', '{"mcp_precharge":"v1"}');`);
  return db;
}

/** One fully valid credits-rail receipt; overrides mutate the field under test. */
function receipt(overrides: Record<string, string> = {}): string {
  const base = {
    buyer_credit_transaction_id: `'${DEBIT}'`,
    buyer_organization_id: `'${ORG}'`,
    mcp_id: `'${MCP}'`,
    tool_name: "'get_weather'",
    payment_type: "'credits'",
    payment_event_id: `'${DEBIT}'`,
    creator_organization_id: `'${ORG}'`,
    base_amount_usd: "0.12",
    affiliate_fee_usd: "0.02",
    platform_fee_usd: "0.00",
    total_amount_usd: "0.14",
    creator_earnings_usd: "0.07",
    platform_earnings_usd: "0.07",
    x402_amount_usd: "0",
    status: "'settling'",
  };
  const row = { ...base, ...overrides };
  const columns = Object.keys(row).join(", ");
  const values = Object.values(row).join(", ");
  return `INSERT INTO mcp_settlements (${columns}) VALUES (${values})`;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0343 mcp settlements migration", () => {
  test("applies cleanly and carries the sweep partial indexes", async () => {
    const db = await database();
    await db.exec(migration);
    const indexes = await db.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes WHERE indexname IN (
        'credit_transactions_mcp_precharge_idx', 'mcp_settlements_resume_due_idx'
      ) ORDER BY indexname
    `);
    expect(indexes.rows.map((r) => r.indexname)).toEqual([
      "credit_transactions_mcp_precharge_idx",
      "mcp_settlements_resume_due_idx",
    ]);
    await db.exec(receipt());
  });

  test("x402 rail rejects a zero amount but the credits rail keeps zero legal", async () => {
    const db = await database();
    await db.exec(migration);
    await expect(
      db.exec(
        receipt({
          payment_type: "'x402'",
          buyer_credit_transaction_id: "NULL",
          payment_event_id: "'x402-evt-1'",
          x402_amount_usd: "0.000000",
        }),
      ),
    ).rejects.toThrow(/mcp_settlements_x402_check/);
    await db.exec(receipt({ payment_event_id: "'credits-evt-1'" }));
  });

  test("rail shape: credits requires its debit, x402 forbids one", async () => {
    const db = await database();
    await db.exec(migration);
    await expect(
      db.exec(receipt({ buyer_credit_transaction_id: "NULL", payment_event_id: "'evt-a'" })),
    ).rejects.toThrow(/mcp_settlements_rail_shape_check/);
    await expect(
      db.exec(
        receipt({
          payment_type: "'x402'",
          payment_event_id: "'evt-b'",
          x402_amount_usd: "0.000100",
        }),
      ),
    ).rejects.toThrow(/mcp_settlements_rail_shape_check/);
  });

  test("receipt check rejects an unbalanced debit and negative legs", async () => {
    const db = await database();
    await db.exec(migration);
    await expect(
      db.exec(receipt({ total_amount_usd: "0.15", payment_event_id: "'evt-c'" })),
    ).rejects.toThrow(/mcp_settlements_receipt_check/);
    await expect(
      db.exec(receipt({ creator_earnings_usd: "-0.01", payment_event_id: "'evt-d'" })),
    ).rejects.toThrow(/mcp_settlements_receipt_check/);
  });

  test("receipt check rejects NaN economic legs (driver 'NaN'::numeric pins)", async () => {
    const db = await database();
    await db.exec(migration);
    // Corrupt NUMERIC columns read back as the literal string "NaN"
    // (#13415): the CHECK's ::text <> 'NaN' guards must refuse them here,
    // not let a NaN receipt reach the ledger legs. ('NaN'::numeric is the
    // only way to write the NaN value in an INSERT literal.)
    const nan = "'NaN'::numeric";
    await expect(
      db.exec(receipt({ creator_earnings_usd: nan, payment_event_id: "'evt-g'" })),
    ).rejects.toThrow(/mcp_settlements_receipt_check/);
    await expect(
      db.exec(receipt({ platform_earnings_usd: nan, payment_event_id: "'evt-h'" })),
    ).rejects.toThrow(/mcp_settlements_receipt_check/);
    await expect(
      db.exec(receipt({ total_amount_usd: nan, payment_event_id: "'evt-i'" })),
    ).rejects.toThrow(/mcp_settlements_receipt_check/);
  });

  test("x402 rail rejects a negative amount", async () => {
    const db = await database();
    await db.exec(migration);
    await expect(
      db.exec(
        receipt({
          payment_type: "'x402'",
          buyer_credit_transaction_id: "NULL",
          payment_event_id: "'evt-j'",
          x402_amount_usd: "-0.000100",
        }),
      ),
    ).rejects.toThrow(/mcp_settlements_x402_check/);
  });

  test("terminal shape and status enum are enforced", async () => {
    const db = await database();
    await db.exec(migration);
    await expect(
      db.exec(receipt({ status: "'settled'", payment_event_id: "'evt-e'" })),
    ).rejects.toThrow(/mcp_settlements_terminal_shape_check/);
    await expect(
      db.exec(receipt({ status: "'bogus'", payment_event_id: "'evt-f'" })),
    ).rejects.toThrow(/mcp_settlements_status_check/);
  });

  test("payment-event uniqueness arbitrates the settlement race", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(receipt());
    await expect(
      db.exec(receipt({ creator_earnings_usd: "0.09", platform_earnings_usd: "0.05" })),
    ).rejects.toThrow(/mcp_settlements_payment_event_uidx/);
  });

  test("one usage row per settlement (mcp_usage_settlement_uidx)", async () => {
    const db = await database();
    await db.exec(migration);
    await db.exec(receipt());
    const settlementId = await db.query<{ id: string }>(
      "SELECT id FROM mcp_settlements WHERE payment_event_id = $1",
      [DEBIT],
    );
    const sid = settlementId.rows[0]?.id;
    expect(sid).toBeTruthy();
    await db.exec(`INSERT INTO mcp_usage (settlement_id) VALUES ('${sid}')`);
    await expect(
      db.exec(`INSERT INTO mcp_usage (settlement_id) VALUES ('${sid}')`),
    ).rejects.toThrow(/mcp_usage_settlement_uidx/);
  });
});
