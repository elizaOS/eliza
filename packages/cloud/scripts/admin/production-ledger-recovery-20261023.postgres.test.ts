import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import {
  loadCanonicalMigrations,
  type Migration,
  validateAppliedMigrationLedger,
} from "./canonical-migration-ledger";
import {
  ALREADY_EFFECTIVE_TAGS,
  EFFECT_FINGERPRINT_SQL,
  loadReviewedEffectFingerprint,
  REVIEWED_ANOMALOUS_ROWS,
  REVIEWED_JOURNAL_LENGTH,
  REVIEWED_PREFIX_LENGTH,
} from "./production-ledger-recovery-20261023";

const { Client } = pg;
const BASE_URL =
  process.env.MIGRATION_TEST_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  "";
const ENABLED =
  process.env.RUN_REAL_POSTGRES_MIGRATION_TESTS === "1" &&
  BASE_URL.startsWith("postgres");
// Production's schema must already hold 0403's columns: 0542 references them.
const OBSERVED_PREREQUISITE_TAGS = ["0403_subscription_app_scope_columns"];
const RECOVERY = readFileSync(
  path.join(import.meta.dir, "production-ledger-recovery-20261023.sql"),
  "utf8",
).replace(/^\\set ON_ERROR_STOP on\n/, "");

const migrations = await loadCanonicalMigrations();
const reviewed = migrations.slice(0, REVIEWED_JOURNAL_LENGTH);
const byTag = new Map(reviewed.map((m) => [m.entry.tag, m]));
const template = `ledger_recovery_tpl_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const databases = new Set<string>([template]);
let admin: pg.Client;

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function apply(client: pg.Client, migration: Migration) {
  // CREATE INDEX CONCURRENTLY cannot run in a transaction; drizzle runs those alone.
  if (migration.statements.some((s) => /\bconcurrently\b/i.test(s))) {
    for (const statement of migration.statements) await client.query(statement);
    return;
  }
  await client.query(`BEGIN;\n${migration.statements.join("\n;\n")};\nCOMMIT;`);
}

async function receipt(client: pg.Client, hash: string, when: number) {
  await client.query(
    "INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ($1, $2)",
    [hash, when],
  );
}

/** The reviewed production state: canonical prefix, the six out-of-order migrations, 373 rows. */
async function buildTemplate() {
  await admin.query(`CREATE DATABASE "${template}"`);
  const client = new Client({ connectionString: databaseUrl(template) });
  await client.connect();
  try {
    await client.query(
      "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    for (const migration of reviewed.slice(0, REVIEWED_PREFIX_LENGTH)) {
      await apply(client, migration);
      await receipt(client, migration.hash, migration.entry.when);
    }
    for (const tag of [
      ...OBSERVED_PREREQUISITE_TAGS,
      ...ALREADY_EFFECTIVE_TAGS,
    ])
      await apply(client, byTag.get(tag) as Migration);
    for (const [offset, row] of REVIEWED_ANOMALOUS_ROWS.entries()) {
      const hash = "tag" in row ? byTag.get(row.tag)?.hash : row.hash;
      await receipt(
        client,
        hash as string,
        reviewed[REVIEWED_PREFIX_LENGTH + offset].entry.when,
      );
    }
  } finally {
    await client.end();
  }
}

async function clone(setup = ""): Promise<pg.Client> {
  const name = `ledger_recovery_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  databases.add(name);
  const client = new Client({ connectionString: databaseUrl(name) });
  await client.connect();
  if (setup) await client.query(setup);
  return client;
}

/** Runs the committed SQL the way psql with ON_ERROR_STOP does; returns the error message. */
async function runRecovery(client: pg.Client): Promise<string | null> {
  try {
    await client.query(RECOVERY);
    return null;
  } catch (error) {
    await client.query("ROLLBACK");
    return (error as Error).message;
  }
}

async function snapshot(client: pg.Client) {
  const ledger = await client.query<{
    id: number;
    hash: string;
    created_at: string;
  }>(
    "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  const sequence = await client.query(
    "SELECT last_value::int, is_called FROM drizzle.__drizzle_migrations_id_seq",
  );
  const retired = await client.query(
    "SELECT to_regclass('drizzle.__drizzle_migrations_retired_20261023') IS NOT NULL AS exists",
  );
  return {
    ledger: ledger.rows,
    sequence: sequence.rows[0],
    retired: retired.rows[0].exists as boolean,
  };
}

async function expectRefused(setup: string, message: string) {
  const client = await clone(setup);
  try {
    const before = await snapshot(client);
    expect(await runRecovery(client)).toContain(message);
    expect(await snapshot(client)).toEqual(before);
    expect(before.retired).toBe(false);
  } finally {
    await client.end();
  }
}

describe.skipIf(!ENABLED)(
  "production ledger recovery (Oct 23) on PostgreSQL",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: BASE_URL });
      await admin.connect();
      await buildTemplate();
    }, 300_000);

    afterAll(async () => {
      for (const name of [...databases].reverse())
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }, 120_000);

    test("the committed fingerprint is the reviewed state's catalog", async () => {
      const client = await clone();
      try {
        const { rows } = await client.query(
          `${EFFECT_FINGERPRINT_SQL}\nORDER BY 1, 2`,
        );
        expect(rows).toEqual(loadReviewedEffectFingerprint());
      } finally {
        await client.end();
      }
    });

    test("commits on the reviewed state, yields the canonical ledger and refuses a re-run", async () => {
      const client = await clone();
      try {
        expect(await runRecovery(client)).toBeNull();
        const after = await snapshot(client);
        expect(after.ledger.length).toBe(REVIEWED_JOURNAL_LENGTH);
        expect(after.sequence).toEqual({
          last_value: REVIEWED_JOURNAL_LENGTH,
          is_called: true,
        });
        expect(after.retired).toBe(true);
        expect(
          validateAppliedMigrationLedger(after.ledger, reviewed)
            .lastAppliedJournalIndex,
        ).toBe(REVIEWED_JOURNAL_LENGTH - 1);
        expect(await runRecovery(client)).toContain("ledger_shape_mismatch");
        expect(await snapshot(client)).toEqual(after);
      } finally {
        await client.end();
      }
    }, 120_000);

    test("refuses a ledger whose prefix hashes are not canonical", () =>
      expectRefused(
        "UPDATE drizzle.__drizzle_migrations SET hash = md5(hash) || md5(hash) WHERE id <= 370",
        "ledger_shape_mismatch",
      ));

    test("refuses a ledger whose timestamps are not canonical", () =>
      expectRefused(
        "UPDATE drizzle.__drizzle_migrations SET created_at = 0 WHERE id <= 370",
        "ledger_shape_mismatch",
      ));

    test("refuses an anomalous row at an unreviewed time", () =>
      expectRefused(
        "UPDATE drizzle.__drizzle_migrations SET created_at = created_at + 1 WHERE id = 372",
        "ledger_shape_mismatch",
      ));

    test("refuses when an already-effective column is missing", () =>
      expectRefused(
        "ALTER TABLE rooms DROP COLUMN connector_server_id",
        "already_effective_schema_mismatch: column rooms.connector_server_id",
      ));

    test("refuses when an already-effective constraint differs", () =>
      expectRefused(
        `ALTER TABLE embeddings DROP CONSTRAINT embedding_space_write_check;
       ALTER TABLE embeddings ADD CONSTRAINT embedding_space_write_check CHECK (space_id IS NULL)`,
        "constraint embeddings.embedding_space_write_check",
      ));

    test("refuses when an already-effective function body differs", () =>
      expectRefused(
        `CREATE OR REPLACE FUNCTION guard_subscription_grant_record() RETURNS trigger
         LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`,
        "function guard_subscription_grant_record",
      ));

    test("a late failure rolls back the ledger rows and the id sequence", async () => {
      // 0545 creates this table unconditionally, after ~140 new receipts.
      const client = await clone(
        "CREATE TABLE inference_policy_mutations (id int)",
      );
      try {
        const before = await snapshot(client);
        const error = await runRecovery(client);
        expect(error).toContain("inference_policy_mutations");
        expect(await snapshot(client)).toEqual(before);
        expect(before.sequence).toEqual({ last_value: 373, is_called: true });
      } finally {
        await client.end();
      }
    }, 120_000);
  },
);
