/**
 * Exercises the production migration CLI against real PostgreSQL sessions.
 * The suite creates disposable databases to prove ledger fencing, catalog
 * drift rejection, lock contention recovery, and terminal exhaustion.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const ROOT = path.resolve(import.meta.dir, "../../../..");
const MIGRATOR = path.join(import.meta.dir, "migrate-with-diagnostics.ts");
const PREFLIGHT = path.join(
  import.meta.dir,
  "preflight-job-execution-interruptions.ts",
);
const MIGRATIONS_DIR = path.join(
  ROOT,
  "packages/cloud/shared/src/db/migrations",
);
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta/_journal.json");
const ADD_COLUMN_CREATED_AT = 1_785_384_000_000;
const CATALOG_GUARD_CREATED_AT = 1_785_528_000_001;
const HISTORICAL_DRIFT_CREATED_AT = 1_770_518_468_000;
// One deployed snapshot omitted these five backward-timestamp entries. Another
// observed ledger contained 0017 and placed both it and 0081 after 0105; the
// hybrid fixture preserves that shape while the other modes preserve the first.
const PRODUCTION_LEGACY_SKIPPED_CREATED_AT = new Set([
  1_764_259_200_000, 1_771_275_600_000, 1_771_275_601_000, 1_771_275_602_000,
  1_771_275_603_000,
]);
const PRODUCTION_HYBRID_SKIPPED_CREATED_AT = new Set([
  1_771_275_600_000, 1_771_275_601_000, 1_771_275_602_000, 1_771_275_603_000,
]);
const PRODUCTION_LATE_BACKFILL_TAGS = [
  "0017_add_organization_encryption_keys", // gitleaks:allow immutable migration tag, not credential material
  "0081_db_optimization_and_r2_trajectories",
] as const;
const PRODUCTION_BACKFILL_ANCHOR_TAG =
  "0105_managed_domains_cloudflare_provider";
const BASE_URL =
  process.env.MIGRATION_TEST_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  "";
const ENABLED =
  process.env.RUN_REAL_POSTGRES_MIGRATION_TESTS === "1" &&
  BASE_URL.startsWith("postgres");

interface JournalEntry {
  when: number;
  tag: string;
}

interface CommandResult {
  exitCode: number;
  output: string;
}

let admin: pg.Client;
const databases = new Set<string>();

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(): Promise<{
  name: string;
  url: string;
  client: pg.Client;
}> {
  const name = `migration_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${quotedIdentifier(name)}`);
  databases.add(name);
  const client = new Client({ connectionString: databaseUrl(name) });
  await client.connect();
  return { name, url: databaseUrl(name), client };
}

async function journalEntries(): Promise<JournalEntry[]> {
  const journal = JSON.parse(await readFile(JOURNAL_PATH, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

async function seedAppliedPrefix(
  client: pg.Client,
  length: number,
  order: "timestamp" | "journal" | "production-hybrid" = "journal",
): Promise<void> {
  await client.query(`
    CREATE TABLE jobs (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY
    );
    CREATE TABLE agent_sandboxes (
      container_name text,
      replacement_cleanup_container_name text
    );
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);

  // Deployed historical runners used both orders. Timestamp mode preserves
  // production inversions where a later journal entry ran first; journal mode
  // preserves older installations that recorded backward timestamps in place.
  const skipped =
    order === "production-hybrid"
      ? PRODUCTION_HYBRID_SKIPPED_CREATED_AT
      : PRODUCTION_LEGACY_SKIPPED_CREATED_AT;
  let entries = (await journalEntries())
    .slice(0, length)
    .filter((entry) => !skipped.has(entry.when));
  if (order !== "journal") {
    entries.sort((left, right) => left.when - right.when);
  }
  if (order === "production-hybrid") {
    const lateBackfills = PRODUCTION_LATE_BACKFILL_TAGS.map((tag) => {
      const entry = entries.find((candidate) => candidate.tag === tag);
      if (!entry) throw new Error(`Missing production backfill fixture ${tag}`);
      return entry;
    });
    entries = entries.filter(
      (entry) =>
        !PRODUCTION_LATE_BACKFILL_TAGS.some((tag) => tag === entry.tag),
    );
    const anchorIndex = entries.findIndex(
      (entry) => entry.tag === PRODUCTION_BACKFILL_ANCHOR_TAG,
    );
    if (anchorIndex === -1) {
      throw new Error(
        `Missing production backfill anchor ${PRODUCTION_BACKFILL_ANCHOR_TAG}`,
      );
    }
    entries.splice(anchorIndex + 1, 0, ...lateBackfills);
  }
  for (const entry of entries) {
    const sql = await readFile(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8",
    );
    const hash = createHash("sha256").update(sql).digest("hex");
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [hash, entry.when],
    );
  }
}

async function runScript(
  script: string,
  database: string,
  overrides: Record<string, string> = {},
): Promise<CommandResult> {
  const processHandle = Bun.spawn(
    ["bun", "--conditions=eliza-source", script],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: database,
        MIGRATION_LOCK_TIMEOUT_MS: "75",
        MIGRATION_LOCK_MAX_ATTEMPTS: "20",
        MIGRATION_LOCK_RETRY_BASE_MS: "5",
        MIGRATION_LOCK_RETRY_MAX_MS: "20",
        JOB_INTERRUPTION_PREFLIGHT_MAX_ATTEMPTS: "1",
        JOB_INTERRUPTION_PREFLIGHT_DELAY_MS: "1",
        ...overrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function waitForAdvisoryLock(client: pg.Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND granted
    `);
    if (Number(result.rows[0]?.count) >= 1) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for migration advisory lock");
}

describe.skipIf(!ENABLED)(
  "migrate-with-diagnostics real PostgreSQL safety",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: BASE_URL });
      await admin.connect();
    });

    afterAll(async () => {
      for (const name of databases) {
        await admin.query(
          `DROP DATABASE IF EXISTS ${quotedIdentifier(name)} WITH (FORCE)`,
        );
      }
      await admin.end();
    }, 120_000);

    test("applies the append-only fix-forward once and passes the reusable catalog preflight", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, 184);
      await database.client.query("INSERT INTO jobs DEFAULT VALUES");

      const first = await runScript(MIGRATOR, database.url);
      expect(first.exitCode, first.output).toBe(0);
      expect(first.output).toContain("pending migrations: 3");

      const catalog = await database.client.query<{
        data_type: string;
        is_nullable: string;
        column_default: string;
        zeros: string;
      }>(`
      SELECT catalog_column.data_type, catalog_column.is_nullable,
        catalog_column.column_default,
        (SELECT count(*)::text FROM jobs WHERE execution_interruptions = 0) AS zeros
      FROM information_schema.columns AS catalog_column
      WHERE catalog_column.table_schema = 'public'
        AND catalog_column.table_name = 'jobs'
        AND catalog_column.column_name = 'execution_interruptions'
    `);
      expect(catalog.rows[0]).toEqual({
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
        zeros: "1",
      });

      const second = await runScript(MIGRATOR, database.url);
      expect(second.exitCode, second.output).toBe(0);
      expect(second.output).toContain("pending migrations: 0");

      const preflight = await runScript(PREFLIGHT, database.url);
      expect(preflight.exitCode, preflight.output).toBe(0);
      expect(preflight.output).toContain("catalog and journal verified");
      await database.client.end();
    }, 30_000);

    test("accepts historical production hash drift but enforces hashes from the checkpoint forward", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, 184);
      await database.client.query(
        "UPDATE drizzle.__drizzle_migrations SET hash = 'historical-drift' WHERE created_at = $1",
        [HISTORICAL_DRIFT_CREATED_AT],
      );

      const migrated = await runScript(MIGRATOR, database.url);
      expect(migrated.exitCode, migrated.output).toBe(0);
      expect(migrated.output).toContain("pending migrations: 3");

      await database.client.query(
        "UPDATE drizzle.__drizzle_migrations SET hash = 'checkpoint-drift' WHERE created_at = $1",
        [CATALOG_GUARD_CREATED_AT],
      );
      const checkpointMismatch = await runScript(MIGRATOR, database.url);
      expect(checkpointMismatch.exitCode).toBe(1);
      expect(checkpointMismatch.output).toContain(
        "Migration ledger hash mismatch for 0187_job_execution_interruptions_catalog_guard",
      );
      await database.client.end();
    }, 30_000);

    test("accepts production timestamp order when legacy journal indexes invert", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, 184, "timestamp");
      const entries = await journalEntries();
      const earlierTimestamp = entries[44];
      const laterTimestamp = entries[43];
      if (!earlierTimestamp || !laterTimestamp) {
        throw new Error("Missing production inversion fixture entries");
      }
      expect(earlierTimestamp.tag).toBe("0044_seed_chain_data_pricing");
      expect(laterTimestamp.tag).toBe(
        "0043_add_missing_referral_context_columns",
      );
      expect(earlierTimestamp.when).toBeLessThan(laterTimestamp.when);

      const inversion = await database.client.query<{
        id: number;
        created_at: string;
      }>(
        `SELECT id, created_at::text
         FROM drizzle.__drizzle_migrations
         WHERE created_at = ANY($1::bigint[])
         ORDER BY id ASC`,
        [[earlierTimestamp.when, laterTimestamp.when]],
      );
      expect(inversion.rows.map((row) => Number(row.created_at))).toEqual([
        earlierTimestamp.when,
        laterTimestamp.when,
      ]);

      const migrated = await runScript(MIGRATOR, database.url);
      expect(migrated.exitCode, migrated.output).toBe(0);
      expect(migrated.output).toContain("pending migrations: 3");
      await database.client.end();
    }, 120_000);

    test("accepts historical journal order when legacy timestamps invert", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, 184, "journal");

      const migrated = await runScript(MIGRATOR, database.url);
      expect(migrated.exitCode, migrated.output).toBe(0);
      expect(migrated.output).toContain("pending migrations: 3");
      await database.client.end();
    }, 120_000);

    test("accepts the production hybrid order with late historical backfills", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, 184, "production-hybrid");
      const entries = await journalEntries();
      const encryptionKeys = entries[17];
      const databaseOptimization = entries[81];
      const managedDomains = entries[101];
      if (!encryptionKeys || !databaseOptimization || !managedDomains) {
        throw new Error("Missing production hybrid fixture entries");
      }

      const appliedOrder = await database.client.query<{
        created_at: string;
      }>(
        `SELECT created_at::text
         FROM drizzle.__drizzle_migrations
         WHERE created_at = ANY($1::bigint[])
         ORDER BY id ASC`,
        [[managedDomains.when, encryptionKeys.when, databaseOptimization.when]],
      );
      expect(appliedOrder.rows.map((row) => Number(row.created_at))).toEqual([
        managedDomains.when,
        encryptionKeys.when,
        databaseOptimization.when,
      ]);

      const migrated = await runScript(MIGRATOR, database.url);
      expect(migrated.exitCode, migrated.output).toBe(0);
      expect(migrated.output).toContain("pending migrations: 3");
      await database.client.end();
    }, 120_000);

    test("rejects historical rows appended after the immutable checkpoint", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, 184);
      const entries = await journalEntries();
      for (const journalIndex of [186, 184, 185]) {
        const entry = entries[journalIndex];
        if (!entry) throw new Error(`Missing journal entry ${journalIndex}`);
        const sql = await readFile(
          path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
          "utf8",
        );
        await database.client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [createHash("sha256").update(sql).digest("hex"), entry.when],
        );
      }

      const result = await runScript(MIGRATOR, database.url);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        "appears after hash enforcement checkpoint",
      );
      await database.client.end();
    }, 120_000);

    test("rejects incompatible catalog drift and malformed ledger prefixes", async () => {
      const drift = await createDatabase();
      await seedAppliedPrefix(drift.client, 184);
      await drift.client.query(
        "ALTER TABLE jobs ADD COLUMN execution_interruptions text DEFAULT 'wrong'",
      );
      const driftResult = await runScript(MIGRATOR, drift.url);
      expect(driftResult.exitCode).toBe(1);
      expect(driftResult.output).toContain(
        "jobs.execution_interruptions catalog mismatch",
      );
      const driftJournal = await drift.client.query<{
        add_column: string;
        catalog_guard: string;
      }>(
        `SELECT
          count(*) FILTER (WHERE created_at = $1)::text AS add_column,
          count(*) FILTER (WHERE created_at = $2)::text AS catalog_guard
         FROM drizzle.__drizzle_migrations`,
        [ADD_COLUMN_CREATED_AT, CATALOG_GUARD_CREATED_AT],
      );
      expect(driftJournal.rows[0]).toEqual({
        add_column: "1",
        catalog_guard: "0",
      });
      await drift.client.end();

      const generated = await createDatabase();
      await seedAppliedPrefix(generated.client, 184);
      await generated.client.query(
        "ALTER TABLE jobs ADD COLUMN execution_interruptions integer GENERATED ALWAYS AS (0) STORED NOT NULL",
      );
      const generatedResult = await runScript(MIGRATOR, generated.url);
      expect(generatedResult.exitCode).toBe(1);
      expect(generatedResult.output).toContain(
        "expected writable integer NOT NULL DEFAULT 0",
      );
      await generated.client.end();

      const duplicate = await createDatabase();
      await seedAppliedPrefix(duplicate.client, 184);
      const last = (
        await duplicate.client.query<{ hash: string; created_at: string }>(
          "SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1",
        )
      ).rows[0];
      await duplicate.client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [last?.hash, last?.created_at],
      );
      const duplicateResult = await runScript(MIGRATOR, duplicate.url);
      expect(duplicateResult.exitCode).toBe(1);
      expect(duplicateResult.output).toContain("duplicate created_at");
      await duplicate.client.end();

      const missingRequired = await createDatabase();
      await seedAppliedPrefix(missingRequired.client, 184);
      const entries = await journalEntries();
      const requiredEntry = entries[100];
      if (!requiredEntry) throw new Error("Missing required journal fixture");
      await missingRequired.client.query(
        "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [requiredEntry.when],
      );
      const missingRequiredResult = await runScript(
        MIGRATOR,
        missingRequired.url,
      );
      expect(missingRequiredResult.exitCode).toBe(1);
      expect(missingRequiredResult.output).toContain(
        `missing required journal entry ${requiredEntry.tag}`,
      );
      await missingRequired.client.end();

      const unknownRow = await createDatabase();
      await seedAppliedPrefix(unknownRow.client, 184);
      await unknownRow.client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('unknown', 9999999999999)",
      );
      const unknownRowResult = await runScript(MIGRATOR, unknownRow.url);
      expect(unknownRowResult.exitCode).toBe(1);
      expect(unknownRowResult.output).toContain("no matching journal entry");
      await unknownRow.client.end();
    }, 300_000);

    test("serializes concurrent migrators and recovers from table-lock contention", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, 184);
      const holder = new Client({ connectionString: database.url });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT count(*) FROM jobs");

      const firstPromise = runScript(MIGRATOR, database.url, {
        MIGRATION_LOCK_MAX_ATTEMPTS: "100",
      });
      const secondPromise = runScript(MIGRATOR, database.url, {
        MIGRATION_LOCK_MAX_ATTEMPTS: "100",
      });
      await waitForAdvisoryLock(database.client);
      await Bun.sleep(250);
      await holder.query("COMMIT");
      await holder.end();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first.exitCode, first.output).toBe(0);
      expect(second.exitCode, second.output).toBe(0);
      const output = `${first.output}${second.output}`;
      expect(output).toContain("lock timeout on attempt");
      expect(output).toContain("migration lock busy on attempt");
      expect(output).toContain("pending migrations: 0");

      const journal = await database.client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [CATALOG_GUARD_CREATED_AT],
      );
      expect(journal.rows[0]?.count).toBe("1");
      await database.client.end();
    }, 30_000);

    test("fails observably after bounded table-lock retries without partial state", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, 184);
      const holder = new Client({ connectionString: database.url });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT count(*) FROM jobs");

      const result = await runScript(MIGRATOR, database.url, {
        MIGRATION_LOCK_TIMEOUT_MS: "50",
        MIGRATION_LOCK_MAX_ATTEMPTS: "2",
        MIGRATION_LOCK_RETRY_BASE_MS: "1",
        MIGRATION_LOCK_RETRY_MAX_MS: "1",
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("exhausted 2 lock-timeout attempts");
      expect(result.output).toContain("code=55P03");

      const state = await database.client.query<{
        columns: string;
        journal: string;
      }>(`
      SELECT
        (SELECT count(*)::text
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'jobs'
           AND column_name = 'execution_interruptions') AS columns,
        (SELECT count(*)::text
         FROM drizzle.__drizzle_migrations
         WHERE created_at IN (${ADD_COLUMN_CREATED_AT}, ${CATALOG_GUARD_CREATED_AT})) AS journal
    `);
      expect(state.rows[0]).toEqual({ columns: "0", journal: "0" });

      await holder.query("ROLLBACK");
      await holder.end();
      await database.client.end();
    }, 30_000);
  },
);
