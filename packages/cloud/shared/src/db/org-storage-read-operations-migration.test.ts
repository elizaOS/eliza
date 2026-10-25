/**
 * Applies the real durable storage-read migration to PGlite and proves tenant,
 * state, terminal-receipt, zero-cost, and attached-ledger database guards.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ORG = "00000000-0000-4000-8000-000000021045";
const OTHER_ORG = "00000000-0000-4000-8000-000000021046";
const USER = "00000000-0000-4000-8000-000000021047";
const OTHER_USER = "00000000-0000-4000-8000-000000021048";
const OBJECT = "00000000-0000-4000-8000-000000021049";
const databases: PGlite[] = [];
const migrationSource = readFileSync(
  join(import.meta.dir, "migrations/0266_org_storage_read_operations.sql"),
  "utf8",
);

async function applyMigration(db: PGlite): Promise<void> {
  for (const statement of migrationSource.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.exec(statement);
  }
}

async function database(apply = true): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  for (const statement of [
    `CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      credit_balance numeric(12,6) DEFAULT 10 NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id)
    )`,
    `CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id uuid NOT NULL REFERENCES users(id),
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      settled_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE org_storage_objects (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      UNIQUE (id, organization_id)
    )`,
  ]) {
    await db.exec(statement);
  }
  await db.query(`INSERT INTO organizations (id) VALUES ($1), ($2)`, [ORG, OTHER_ORG]);
  await db.query(`INSERT INTO users (id, organization_id) VALUES ($1, $2), ($3, $4)`, [
    USER,
    ORG,
    OTHER_USER,
    OTHER_ORG,
  ]);
  await db.query(`INSERT INTO org_storage_objects (id, organization_id) VALUES ($1, $2)`, [
    OBJECT,
    ORG,
  ]);
  if (apply) await applyMigration(db);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

function insertPrepared(db: PGlite, params: { method: string; price: string; user?: string }) {
  return db.query<{ id: string }>(
    `INSERT INTO org_storage_read_operations (
      organization_id, user_id, idempotency_key_hash, request_digest, method, price_usd
    ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [ORG, params.user ?? USER, "a".repeat(64), "b".repeat(64), params.method, params.price],
  );
}

describe("0266 durable storage read authority", () => {
  test("fails closed on replay or a partial table collision", async () => {
    const migrated = await database();
    const renewalConstraint = await migrated.query<{
      conname: string;
      definition: string;
    }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'org_storage_read_operations'::regclass
         AND conname = 'org_storage_read_operations_renewal_root_fkey'`,
    );
    expect(renewalConstraint.rows).toEqual([
      {
        conname: "org_storage_read_operations_renewal_root_fkey",
        definition:
          "FOREIGN KEY (renewal_root_id) REFERENCES org_storage_read_operations(id) ON DELETE RESTRICT",
      },
    ]);
    await expect(applyMigration(migrated)).rejects.toThrow(/already exists/i);
    const partial = await database(false);
    await partial.exec(`CREATE TABLE org_storage_read_operations (
      id uuid PRIMARY KEY, collision_marker text NOT NULL
    )`);
    await expect(applyMigration(partial)).rejects.toThrow(/already exists/i);
    const columns = await partial.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'org_storage_read_operations' ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([{ column_name: "collision_marker" }, { column_name: "id" }]);
  });
  test("rejects cross-tenant actors and invalid state skips", async () => {
    const db = await database();
    await expect(
      insertPrepared(db, { method: "list", price: "0", user: OTHER_USER }),
    ).rejects.toThrow("storage read actor tenant mismatch");
    await expect(
      db.query(
        `INSERT INTO org_storage_read_operations (
          organization_id, user_id, idempotency_key_hash, request_digest, method,
          state, price_usd, response_status, response_json, provider_succeeded_at, completed_at
        ) VALUES ($1, $2, $3, $4, 'list', 'committed', 0, 200, '{}', now(), now())`,
        [ORG, USER, "c".repeat(64), "d".repeat(64)],
      ),
    ).rejects.toThrow("storage read must start prepared");
    const forbiddenBirthFields = [
      ["response_status", "200"],
      ["response_json", "'{}'"],
      ["object_generation", "1"],
      ["provider_key", "'provider-result'"],
      ["result_size_bytes", "1"],
      ["result_content_type", "'application/octet-stream'"],
      ["result_etag", "'etag'"],
      ["provider_succeeded_at", "now()"],
      ["completed_at", "now()"],
      ["credit_transaction_id", "gen_random_uuid()"],
      ["capability_revoked_at", "now()"],
      ["last_access_at", "now()"],
      ["access_count", "1"],
    ] as const;
    for (const [index, [column, expression]] of forbiddenBirthFields.entries()) {
      const hash = index.toString(16).repeat(64);
      const digest = ((index + 1) % 16).toString(16).repeat(64);
      await expect(
        db.query(
          `INSERT INTO org_storage_read_operations (
            organization_id, user_id, idempotency_key_hash, request_digest,
            method, price_usd, "${column}"
          ) VALUES ($1, $2, $3, $4, 'list', 0, ${expression})`,
          [ORG, USER, hash, digest],
        ),
      ).rejects.toThrow("storage read birth result authority must be empty");
    }
    const root = await db.query<{ id: string }>(
      `INSERT INTO org_storage_read_operations (
        organization_id, user_id, object_id, idempotency_key_hash, request_digest,
        method, price_usd, capability_id, capability_host, capability_issued_at,
        capability_expires_at, retain_until
      ) VALUES ($1, $2, $3, $4, $5, 'presign', 0,
        '00000000-0000-4000-8000-000000021050', 'blob.example.test', now(),
        now() + interval '5 minutes', now() + interval '5 minutes') RETURNING id`,
      [ORG, USER, OBJECT, "e".repeat(64), "f".repeat(64)],
    );
    const renewal = await db.query<{ state: string }>(
      `INSERT INTO org_storage_read_operations (
        organization_id, user_id, object_id, idempotency_key_hash, request_digest,
        renewal_root_id, renewal_generation, method, price_usd, capability_id,
        capability_host, capability_issued_at, capability_expires_at, retain_until
      ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'presign', 0,
        '00000000-0000-4000-8000-000000021051', 'blob.example.test', now(),
        now() + interval '5 minutes', now() + interval '5 minutes') RETURNING state`,
      [ORG, USER, OBJECT, "1".repeat(64), "2".repeat(64), root.rows[0]!.id],
    );
    expect(renewal.rows).toEqual([{ state: "prepared" }]);
    const inserted = await insertPrepared(db, { method: "list", price: "0" });
    await expect(
      db.query(
        `UPDATE org_storage_read_operations SET state = 'committed',
          response_status = 200, response_json = '{}', completed_at = now()
        WHERE id = $1`,
        [inserted.rows[0]!.id],
      ),
    ).rejects.toThrow("invalid storage read state transition");
  });

  test("persists a terminal zero-cost tombstone and prevents response rewriting", async () => {
    const db = await database();
    const inserted = await insertPrepared(db, { method: "list", price: "0" });
    const id = inserted.rows[0]!.id;
    await db.query(
      `UPDATE org_storage_read_operations SET state = 'provider_succeeded',
        response_status = 200, response_json = '{"items":[]}', provider_succeeded_at = now()
      WHERE id = $1`,
      [id],
    );
    await db.query(
      `UPDATE org_storage_read_operations SET state = 'committed', completed_at = now() WHERE id = $1`,
      [id],
    );
    const receipt = await db.query<{ state: string; credit_transaction_id: string | null }>(
      `SELECT state, credit_transaction_id FROM org_storage_read_operations WHERE id = $1`,
      [id],
    );
    expect(receipt.rows).toEqual([{ state: "committed", credit_transaction_id: null }]);
    await expect(
      db.query(`UPDATE org_storage_read_operations SET response_json = '{}' WHERE id = $1`, [id]),
    ).rejects.toThrow("storage read response authority is immutable");
  });

  test("requires and freezes an exact settled debit for a paid receipt", async () => {
    const db = await database();
    const inserted = await insertPrepared(db, { method: "get", price: "0.250000" });
    const id = inserted.rows[0]!.id;
    const credit = await db.query<{ id: string }>(
      `INSERT INTO credit_transactions (
        organization_id, user_id, amount, type, metadata, settled_at
      ) VALUES ($1, $2, -0.250000, 'debit', $3::jsonb, now()) RETURNING id`,
      [
        ORG,
        USER,
        JSON.stringify({
          settlement_marker: "storage_read_receipt_v2",
          storage_read_operation_id: id,
          request_digest: "b".repeat(64),
          method: "get",
          price_usd: "0.250000",
        }),
      ],
    );
    const creditId = credit.rows[0]!.id;
    await expect(
      db.query(`UPDATE org_storage_read_operations SET credit_transaction_id = $2 WHERE id = $1`, [
        id,
        creditId,
      ]),
    ).rejects.toThrow("storage read debit attaches only at paid commit");
    await expect(
      db.query(
        `UPDATE org_storage_read_operations SET state = 'provider_succeeded', object_id = $2,
          object_generation = 1, provider_key = 'opaque-provider-generation',
          result_size_bytes = 7, result_content_type = 'audio/ogg', result_etag = 'etag-1',
          response_status = 200, response_json = '{"size":7}', provider_succeeded_at = now(),
          credit_transaction_id = $3 WHERE id = $1`,
        [id, OBJECT, creditId],
      ),
    ).rejects.toThrow("storage read debit attaches only at paid commit");
    await db.query(
      `UPDATE org_storage_read_operations SET state = 'provider_succeeded', object_id = $2,
        object_generation = 1, provider_key = 'opaque-provider-generation', result_size_bytes = 7,
        result_content_type = 'audio/ogg', result_etag = 'etag-1', response_status = 200,
        response_json = '{"size":7}', provider_succeeded_at = now() WHERE id = $1`,
      [id, OBJECT],
    );
    await db.query(
      `UPDATE org_storage_read_operations SET state = 'committed',
        credit_transaction_id = $2, completed_at = now() WHERE id = $1`,
      [id, creditId],
    );
    await expect(
      db.query(`UPDATE credit_transactions SET amount = -0.1 WHERE id = $1`, [creditId]),
    ).rejects.toThrow("attached storage read credit is immutable");
    await expect(
      db.query(`DELETE FROM org_storage_read_operations WHERE id = $1`, [id]),
    ).rejects.toThrow("storage read receipts are immutable audit history");
    await expect(db.exec(`TRUNCATE org_storage_read_operations`)).rejects.toThrow(
      "storage read receipts are immutable audit history",
    );
    await expect(
      db.query(`DELETE FROM credit_transactions WHERE id = $1`, [creditId]),
    ).rejects.toThrow("attached storage read credit is immutable");
  });
});
