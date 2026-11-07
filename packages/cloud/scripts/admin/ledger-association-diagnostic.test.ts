import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadCanonicalMigrations } from "./canonical-migration-ledger";
import {
  describeLedgerAssociations,
  inspectGmailReceiptCatalog,
  inspectLedgerAssociations,
} from "./ledger-association-diagnostic";

const migrations = await loadCanonicalMigrations();
test("real ledger associations expose only reviewed tags and classify gaps, unknown, ambiguity, and order", async () => {
  const db = new PGlite("memory://");
  const funding = migrations.find(
    (m) => m.entry.tag === "0387_agent_compute_funding",
  );
  const gmail = migrations.find(
    (m) => m.entry.tag === "0509_managed_gmail_operation_receipts",
  );
  if (!funding || !gmail) throw new Error("Missing reviewed fixtures");
  try {
    await db.exec(
      "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial, hash text, created_at bigint)",
    );
    await db.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2),($3,$4),($5,$6)",
      [
        gmail.hash,
        funding.entry.when,
        funding.hash,
        gmail.entry.when,
        "PRIVATE_HASH",
        123,
      ],
    );
    await db.exec("BEGIN READ ONLY");
    const report = await inspectLedgerAssociations(db, migrations);
    expect(report.associations[0]).toEqual({
      timestampTag: funding.entry.tag,
      hashTag: gmail.entry.tag,
      hashStatus: "unique",
    });
    expect(report.recognizedHashOrder).toBe(false);
    expect(report.unknownHashCount).toBe(1);
    expect(report.unobservedCanonicalTags).not.toContain(gmail.entry.tag);
    expect(report.unobservedCanonicalTags).not.toContain(funding.entry.tag);
    const text = JSON.stringify(report);
    for (const privateValue of [
      "PRIVATE_HASH",
      gmail.hash,
      funding.hash,
      String(funding.entry.when),
    ])
      expect(text).not.toContain(privateValue);
    const ambiguous = describeLedgerAssociations(
      [{ id: 1, hash: gmail.hash, created_at: funding.entry.when }],
      [
        ...migrations,
        {
          ...gmail,
          entry: { ...gmail.entry, tag: "reviewed_duplicate_fixture" },
        },
      ],
    );
    expect(ambiguous.ambiguousHashCount).toBe(1);
    expect(ambiguous.associations[0].hashTag).toBeNull();
    await db.exec("COMMIT");
  } finally {
    await db.close();
  }
});

test("actual Gmail SQL catalog matches and drift is scrubbed inside read-only transactions", async () => {
  const db = new PGlite("memory://");
  try {
    await db.exec(
      "CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY)",
    );
    const absent = await inspectGmailReceiptCatalog(db, migrations);
    expect(Object.values(absent).every((v) => !v)).toBe(true);
    await db.exec(
      await readFile(
        new URL(
          "../../shared/src/db/migrations/0509_managed_gmail_operation_receipts.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec("BEGIN READ ONLY");
    const report = await inspectGmailReceiptCatalog(db, migrations);
    expect(Object.values(report).every(Boolean)).toBe(true);
    await db.exec(
      "COMMIT; ALTER TABLE managed_gmail_operation_receipts DISABLE TRIGGER managed_gmail_operation_receipt_guard",
    );
    await db.exec(
      "CREATE OR REPLACE FUNCTION guard_managed_gmail_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'PRIVATE_BODY'; RETURN NEW; END; $$; BEGIN READ ONLY",
    );
    const drift = await inspectGmailReceiptCatalog(db, migrations);
    expect(drift.functionDefinitionMatches).toBe(false);
    expect(drift.triggerDefinitionMatches).toBe(false);
    expect(JSON.stringify(drift)).not.toContain("PRIVATE_BODY");
    await db.exec("COMMIT");
  } finally {
    await db.close();
  }
});
