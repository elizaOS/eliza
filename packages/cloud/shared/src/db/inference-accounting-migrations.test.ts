/**
 * Applies the inference-accounting migrations to an isolated PGlite database
 * and proves their money, identity, and revision invariants using real SQL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const MIGRATION_TAGS = [
  "0177_organization_balance_revision",
  "0178_app_creator_shadow_idempotency",
  "0179_affiliate_payout_outbox",
  "0180_anonymous_chat_gate_revision",
  "0181_app_usage_projections",
] as const;

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const AFFILIATE_USER_ID = "22222222-2222-4222-8222-222222222222";
const EXISTING_ANONYMOUS_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const NEW_ANONYMOUS_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const AFFILIATE_CODE_ID = "55555555-5555-4555-8555-555555555555";

type MigrationTag = (typeof MIGRATION_TAGS)[number];

let client: PGlite;

function migrationStatements(tag: MigrationTag): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(tag: MigrationTag): Promise<void> {
  for (const statement of migrationStatements(tag)) {
    await client.exec(statement);
  }
}

async function revisionForOrganization(): Promise<number> {
  const result = await client.query<{ balance_revision: string | number | bigint }>(
    "SELECT balance_revision FROM organizations WHERE id = $1",
    [ORGANIZATION_ID],
  );
  return Number(result.rows[0]?.balance_revision);
}

async function insertLedgerRow(params: {
  id: string;
  entryType: string;
  source: string;
  sourceId: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO redeemable_earnings_ledger
      (id, entry_type, earnings_source, source_id, metadata)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb)`,
    [params.id, params.entryType, params.source, params.sourceId, JSON.stringify(params.metadata)],
  );
}

async function insertOutboxRow(params: {
  id: string;
  sourceId: string;
  amount: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO affiliate_payout_outbox
      (id, source_id, affiliate_code_id, affiliate_user_id, amount, description)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::numeric, 'migration proof')`,
    [params.id, params.sourceId, AFFILIATE_CODE_ID, AFFILIATE_USER_ID, params.amount],
  );
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      credit_balance numeric(18, 6) NOT NULL DEFAULT 0
    );

    CREATE TABLE users (
      id uuid PRIMARY KEY
    );

    CREATE TABLE app_earnings_transactions (
      id uuid PRIMARY KEY,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE redeemable_earnings_ledger (
      id uuid PRIMARY KEY,
      entry_type text NOT NULL,
      earnings_source text,
      source_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE anonymous_sessions (
      id uuid PRIMARY KEY
    );

    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY,
      type text NOT NULL DEFAULT 'debit',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp NOT NULL DEFAULT NOW()
    );

    INSERT INTO organizations (id, credit_balance)
    VALUES ('${ORGANIZATION_ID}', 10);

    INSERT INTO users (id)
    VALUES ('${AFFILIATE_USER_ID}');

    INSERT INTO anonymous_sessions (id)
    VALUES ('${EXISTING_ANONYMOUS_SESSION_ID}');
  `);

  for (const tag of MIGRATION_TAGS) {
    await applyMigration(tag);
  }
}, 120_000);

afterAll(async () => {
  await client.close();
});

describe("0177-0181 inference accounting migrations", () => {
  test("journal order is monotonic, registered, and not future-dated", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const entries = journal.entries.filter((entry) =>
      MIGRATION_TAGS.includes(entry.tag as MigrationTag),
    );

    expect(entries.map((entry) => entry.tag)).toEqual([...MIGRATION_TAGS]);
    for (let index = 1; index < entries.length; index++) {
      expect(entries[index]!.when).toBeGreaterThan(entries[index - 1]!.when);
    }
    expect(entries.at(-1)!.when).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(MIGRATION_TAGS.map((tag) => migrationStatements(tag).length)).toEqual([5, 3, 3, 1, 4]);
  });

  test("0177 advances revisions only when the organization balance changes", async () => {
    const initialRevision = await revisionForOrganization();

    await client.query("UPDATE organizations SET credit_balance = credit_balance WHERE id = $1", [
      ORGANIZATION_ID,
    ]);
    expect(await revisionForOrganization()).toBe(initialRevision);

    await client.query(
      "UPDATE organizations SET credit_balance = credit_balance + 1 WHERE id = $1",
      [ORGANIZATION_ID],
    );
    expect(await revisionForOrganization()).toBe(initialRevision + 1);
  });

  test("0178 enforces creator and versioned ledger identities without constraining legacy rows", async () => {
    const creatorIdentity = "creator-ledger-entry-1";
    await client.query(
      "INSERT INTO app_earnings_transactions (id, metadata) VALUES ($1::uuid, $2::jsonb)",
      [
        "60000000-0000-4000-8000-000000000001",
        JSON.stringify({ redeemableLedgerEntryId: creatorIdentity }),
      ],
    );
    await expect(
      client.query(
        "INSERT INTO app_earnings_transactions (id, metadata) VALUES ($1::uuid, $2::jsonb)",
        [
          "60000000-0000-4000-8000-000000000002",
          JSON.stringify({ redeemableLedgerEntryId: creatorIdentity }),
        ],
      ),
    ).rejects.toThrow();
    await client.query(
      "INSERT INTO app_earnings_transactions (id, metadata) VALUES ($1::uuid, '{}'::jsonb), ($2::uuid, '{}'::jsonb)",
      ["60000000-0000-4000-8000-000000000003", "60000000-0000-4000-8000-000000000004"],
    );

    const miniappSourceId = "70000000-0000-4000-8000-000000000001";
    await insertLedgerRow({
      id: "71000000-0000-4000-8000-000000000001",
      entryType: "earning",
      source: "miniapp",
      sourceId: miniappSourceId,
      metadata: { appCreatorShadowVersion: 1 },
    });
    await expect(
      insertLedgerRow({
        id: "71000000-0000-4000-8000-000000000002",
        entryType: "earning",
        source: "miniapp",
        sourceId: miniappSourceId,
        metadata: { appCreatorShadowVersion: 1 },
      }),
    ).rejects.toThrow();
    await insertLedgerRow({
      id: "71000000-0000-4000-8000-000000000003",
      entryType: "earning",
      source: "miniapp",
      sourceId: miniappSourceId,
      metadata: {},
    });
    await insertLedgerRow({
      id: "71000000-0000-4000-8000-000000000004",
      entryType: "earning",
      source: "miniapp",
      sourceId: miniappSourceId,
      metadata: {},
    });

    const affiliateSourceId = "80000000-0000-4000-8000-000000000001";
    await insertLedgerRow({
      id: "81000000-0000-4000-8000-000000000001",
      entryType: "earning",
      source: "affiliate",
      sourceId: affiliateSourceId,
      metadata: { affiliatePayoutVersion: 1 },
    });
    await expect(
      insertLedgerRow({
        id: "81000000-0000-4000-8000-000000000002",
        entryType: "earning",
        source: "affiliate",
        sourceId: affiliateSourceId,
        metadata: { affiliatePayoutVersion: 1 },
      }),
    ).rejects.toThrow();
    await insertLedgerRow({
      id: "81000000-0000-4000-8000-000000000003",
      entryType: "earning",
      source: "affiliate",
      sourceId: affiliateSourceId,
      metadata: {},
    });
    await insertLedgerRow({
      id: "81000000-0000-4000-8000-000000000004",
      entryType: "earning",
      source: "affiliate",
      sourceId: affiliateSourceId,
      metadata: {},
    });
  });

  test("0179 rejects non-canonical sources and non-positive amounts while preserving liabilities", async () => {
    await insertOutboxRow({
      id: "90000000-0000-4000-8000-000000000001",
      sourceId: "affiliate-request-1",
      amount: "0.1000",
    });

    await expect(
      insertOutboxRow({
        id: "90000000-0000-4000-8000-000000000002",
        sourceId: "",
        amount: "0.1000",
      }),
    ).rejects.toThrow();
    await expect(
      insertOutboxRow({
        id: "90000000-0000-4000-8000-000000000003",
        sourceId: " affiliate-request-2 ",
        amount: "0.1000",
      }),
    ).rejects.toThrow();
    await expect(
      insertOutboxRow({
        id: "90000000-0000-4000-8000-000000000004",
        sourceId: "affiliate-request-zero",
        amount: "0",
      }),
    ).rejects.toThrow();
    await expect(
      insertOutboxRow({
        id: "90000000-0000-4000-8000-000000000005",
        sourceId: "affiliate-request-negative",
        amount: "-0.0001",
      }),
    ).rejects.toThrow();
    await expect(
      insertOutboxRow({
        id: "90000000-0000-4000-8000-000000000006",
        sourceId: "affiliate-request-1",
        amount: "0.1000",
      }),
    ).rejects.toThrow();

    await expect(
      client.query("DELETE FROM users WHERE id = $1::uuid", [AFFILIATE_USER_ID]),
    ).rejects.toThrow();
    const liability = await client.query<{ affiliate_user_id: string }>(
      "SELECT affiliate_user_id FROM affiliate_payout_outbox WHERE source_id = 'affiliate-request-1'",
    );
    expect(liability.rows).toEqual([{ affiliate_user_id: AFFILIATE_USER_ID }]);
  });

  test("0180 backfills existing sessions and defaults new sessions to revision zero", async () => {
    await client.query("INSERT INTO anonymous_sessions (id) VALUES ($1::uuid)", [
      NEW_ANONYMOUS_SESSION_ID,
    ]);
    const rows = await client.query<{ id: string; gate_revision: string | number | bigint }>(
      "SELECT id, gate_revision FROM anonymous_sessions ORDER BY id",
    );

    expect(rows.rows).toEqual([
      { id: EXISTING_ANONYMOUS_SESSION_ID, gate_revision: 0 },
      { id: NEW_ANONYMOUS_SESSION_ID, gate_revision: 0 },
    ]);
  });

  test("0181 makes the debit transaction the exactly-once app usage identity", async () => {
    const transactionId = "a0000000-0000-4000-8000-000000000001";
    const negativeCreditsTransactionId = "a0000000-0000-4000-8000-000000000002";
    const invalidStatusTransactionId = "a0000000-0000-4000-8000-000000000003";
    await client.query(
      `INSERT INTO credit_transactions (id)
       VALUES ($1::uuid), ($2::uuid), ($3::uuid)`,
      [transactionId, negativeCreditsTransactionId, invalidStatusTransactionId],
    );
    await client.query(
      `INSERT INTO app_usage_projections
        (charge_transaction_id, app_id, user_id, credits_used, status, projected_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 0.25, 'applied', NOW())`,
      [transactionId, ORGANIZATION_ID, AFFILIATE_USER_ID],
    );
    await expect(
      client.query(
        `INSERT INTO app_usage_projections
          (charge_transaction_id, app_id, user_id, credits_used, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 0.25, 'applied')`,
        [transactionId, ORGANIZATION_ID, AFFILIATE_USER_ID],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO app_usage_projections
          (charge_transaction_id, app_id, user_id, credits_used, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, -1, 'applied')`,
        [negativeCreditsTransactionId, ORGANIZATION_ID, AFFILIATE_USER_ID],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO app_usage_projections
          (charge_transaction_id, app_id, user_id, credits_used, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'unknown')`,
        [invalidStatusTransactionId, ORGANIZATION_ID, AFFILIATE_USER_ID],
      ),
    ).rejects.toThrow();

    await client.query("DELETE FROM credit_transactions WHERE id = $1::uuid", [transactionId]);
    const rows = await client.query<{ count: string | number | bigint }>(
      "SELECT count(*) AS count FROM app_usage_projections",
    );
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  test("all five migrations reapply without duplicating the trigger or schema objects", async () => {
    const beforeRevision = await revisionForOrganization();
    for (const tag of MIGRATION_TAGS) {
      await applyMigration(tag);
    }

    await client.query(
      "UPDATE organizations SET credit_balance = credit_balance + 1 WHERE id = $1",
      [ORGANIZATION_ID],
    );
    expect(await revisionForOrganization()).toBe(beforeRevision + 1);

    const gateColumns = await client.query<{ count: string | number | bigint }>(
      `SELECT count(*) AS count
       FROM information_schema.columns
       WHERE table_name = 'anonymous_sessions'
         AND column_name = 'gate_revision'`,
    );
    expect(Number(gateColumns.rows[0]?.count)).toBe(1);

    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE indexname IN (
         'app_earnings_tx_creator_shadow_idempotency_uidx',
         'redeemable_earnings_ledger_miniapp_creator_movement_uidx',
         'redeemable_earnings_ledger_affiliate_payout_identity_uidx',
         'affiliate_payout_outbox_source_uidx',
         'affiliate_payout_outbox_pending_due_idx',
         'app_usage_projections_app_created_idx',
         'app_usage_projections_status_created_idx',
         'credit_transactions_app_usage_projection_source_idx'
       )`,
    );
    expect(new Set(indexes.rows.map((row) => row.indexname))).toEqual(
      new Set([
        "app_earnings_tx_creator_shadow_idempotency_uidx",
        "redeemable_earnings_ledger_miniapp_creator_movement_uidx",
        "redeemable_earnings_ledger_affiliate_payout_identity_uidx",
        "affiliate_payout_outbox_source_uidx",
        "affiliate_payout_outbox_pending_due_idx",
        "app_usage_projections_app_created_idx",
        "app_usage_projections_status_created_idx",
        "credit_transactions_app_usage_projection_source_idx",
      ]),
    );
  });
});
