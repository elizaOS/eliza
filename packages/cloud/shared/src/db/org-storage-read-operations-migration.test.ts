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

async function database(): Promise<PGlite> {
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
  const source = readFileSync(
    join(import.meta.dir, "migrations/0264_org_storage_read_operations.sql"),
    "utf8",
  );
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.exec(statement);
  }
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

describe("0264 durable storage read authority", () => {
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
    await db.query(
      `UPDATE org_storage_read_operations SET state = 'provider_succeeded', object_id = $2,
        object_generation = 1, provider_key = 'opaque-provider-generation', result_size_bytes = 7,
        result_content_type = 'audio/ogg', result_etag = 'etag-1', response_status = 200,
        response_json = '{"size":7}', provider_succeeded_at = now() WHERE id = $1`,
      [id, OBJECT],
    );
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
    await db.query(
      `UPDATE org_storage_read_operations SET state = 'committed',
        credit_transaction_id = $2, completed_at = now() WHERE id = $1`,
      [id, creditId],
    );
    await expect(
      db.query(`UPDATE credit_transactions SET amount = -0.1 WHERE id = $1`, [creditId]),
    ).rejects.toThrow("attached storage read credit is immutable");
    await expect(
      db.query(`DELETE FROM credit_transactions WHERE id = $1`, [creditId]),
    ).rejects.toThrow("attached storage read credit is immutable");
  });
});
