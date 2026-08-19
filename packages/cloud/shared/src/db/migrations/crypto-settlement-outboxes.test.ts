/** Applies migration 0255 to real PGlite for legacy collision and safe canonicalization proof. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const databases: PGlite[] = [];
const migration = await readFile(
  new URL("./0255_crypto_settlement_outboxes.sql", import.meta.url),
  "utf8",
);

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`CREATE TABLE crypto_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_hash text, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0255 crypto settlement migration", () => {
  test("fails closed when active legacy EVM casing aliases already collide", async () => {
    const db = await database();
    await db.exec(`INSERT INTO crypto_payments(transaction_hash, status) VALUES
      ('0xAbCd', 'confirmed'), ('0xaBcD', 'broadcast')`);
    await expect(db.exec(migration)).rejects.toThrow(/duplicate EVM transaction hashes/i);
    const rows = await db.query<{ transaction_hash: string }>(
      "SELECT transaction_hash FROM crypto_payments ORDER BY transaction_hash",
    );
    expect(rows.rows.map((row) => row.transaction_hash)).toEqual(["0xAbCd", "0xaBcD"]);
  });

  test("canonicalizes safe legacy EVM rows, preserves Solana case, and enforces lower uniqueness", async () => {
    const db = await database();
    await db.exec(`INSERT INTO crypto_payments(transaction_hash, status) VALUES
      ('0xAbCd', 'confirmed'), ('SoLaNaCase', 'confirmed')`);
    await db.exec(migration);
    const rows = await db.query<{ transaction_hash: string }>(
      "SELECT transaction_hash FROM crypto_payments ORDER BY transaction_hash",
    );
    expect(rows.rows.map((row) => row.transaction_hash)).toEqual(["0xabcd", "SoLaNaCase"]);
    const preparedColumn = await db.query<{ data_type: string }>(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'crypto_sweep_outbox' AND column_name = 'prepared_transaction'
    `);
    expect(preparedColumn.rows).toEqual([{ data_type: "text" }]);
    await expect(
      db.exec(`INSERT INTO crypto_sweep_outbox(
        payment_id, payload, payload_digest, prepared_transaction
      ) VALUES (
        (SELECT id FROM crypto_payments WHERE transaction_hash = '0xabcd'),
        '{}', 'digest', 'signed-transaction'
      )`),
    ).rejects.toThrow(/prepared_pair/i);
    await db.exec(`INSERT INTO crypto_sweep_outbox(
        payment_id, payload, payload_digest, prepared_transaction,
        sweep_transaction_hash, prepared_metadata
      ) VALUES (
        (SELECT id FROM crypto_payments WHERE transaction_hash = '0xabcd'),
        '{}', 'digest', 'signed-transaction', 'hash', '{"network":"solana"}'
      )`);
    await expect(
      db.exec("INSERT INTO crypto_payments(transaction_hash, status) VALUES ('0xABCD', 'pending')"),
    ).rejects.toThrow();
  });
});
