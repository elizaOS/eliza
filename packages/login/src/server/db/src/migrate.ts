/** Applies the owned identity migration history under a PostgreSQL session lock. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { logger } from "@elizaos/logger";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDb } from "./client";

const MIGRATIONS_FOLDER = new URL("../drizzle", import.meta.url).pathname;
const ADVISORY_LOCK_KEY = "steward_migrations";

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

interface Journal {
  entries: JournalEntry[];
}

/**
 * The legacy `psql -f` deploy loop was retired when this migrator was
 * introduced; the journal tip at that moment was 0024_audit_events. A legacy
 * DB is therefore only provably migrated through that tag — entries past it
 * must be APPLIED by the migrator, never seeded.
 */
export const LEGACY_BACKFILL_TIP_TAG = "0024_audit_events";

/**
 * Fingerprint proving a legacy DB actually reached the psql-era tip: the
 * newest table 0024 created. `public.tenants` (0000) alone says nothing about
 * how far the psql loop got before the DB was frozen.
 */
export const LEGACY_BACKFILL_FINGERPRINT_TABLE = "public.audit_events";

/**
 * Select the journal entries a legacy DB may be seeded with: everything up to
 * and including the psql-era tip. Throws if the tip is absent from the
 * journal (should never happen — it is a historical entry).
 */
export function selectLegacyBackfillEntries(journal: Journal): JournalEntry[] {
  const tipIndex = journal.entries.findIndex(
    (entry) => entry.tag === LEGACY_BACKFILL_TIP_TAG,
  );
  if (tipIndex === -1) {
    throw new Error(
      `[migrate] Backfill-era tip ${LEGACY_BACKFILL_TIP_TAG} is missing from the migration journal; refusing to seed a legacy DB`,
    );
  }
  return journal.entries.slice(0, tipIndex + 1);
}

function readJournal(): Journal {
  const path = `${MIGRATIONS_FOLDER}/meta/_journal.json`;
  return JSON.parse(readFileSync(path, "utf-8")) as Journal;
}

function hashMigration(tag: string): string {
  // Drizzle hashes the raw .sql file contents with sha256.
  const sql = readFileSync(`${MIGRATIONS_FOLDER}/${tag}.sql`, "utf-8");
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Run drizzle-kit migrations under a Postgres advisory session lock so
 * concurrent API replicas don't race on startup. Returns the tags of
 * migrations applied during this call (empty if everything was up to date).
 *
 * On first run against a DB that pre-dates this migrator (the deploy script
 * used to `psql -f` each .sql by hand), we backfill `drizzle.__drizzle_migrations`
 * from the journal so the migrator doesn't try to re-apply non-idempotent DDL.
 * Heuristic: if `__drizzle_migrations` is empty AND `tenants` exists (was
 * created by 0000), the DB came from the psql loop. We then FINGERPRINT the
 * psql-era tip (`LEGACY_BACKFILL_FINGERPRINT_TABLE`, created by 0024) and seed
 * only the entries through that tip — seeding the whole current journal would
 * silently skip every migration between the DB's true tip and now, including
 * constraint-only hardening migrations whose absence produces no runtime error.
 */
export async function runMigrations(): Promise<{ applied: string[] }> {
  const { client, db } = createDb();

  try {
    // Session-scoped advisory lock spans the whole migrator (which uses its
    // own transaction). pg_advisory_lock blocks until acquired.
    await client`SELECT pg_advisory_lock(hashtextextended(${ADVISORY_LOCK_KEY}, 0))`;

    try {
      const journal = readJournal();

      // Ensure schema + table exist so we can inspect before drizzle's migrator runs.
      await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
      await client`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `;

      const existingRows = (await client`
        SELECT created_at FROM drizzle.__drizzle_migrations
      `) as Array<{ created_at: string | number | null }>;

      const tenantsExists = (await client`
        SELECT to_regclass('public.tenants') AS r
      `) as Array<{ r: string | null }>;

      // Backfill: legacy DB previously migrated by the psql loop.
      if (existingRows.length === 0 && tenantsExists[0]?.r) {
        // Fingerprint the psql-era tip before trusting the heuristic: a DB
        // frozen at an older tip must fail loudly here, not be seeded with
        // migrations it never applied.
        const fingerprint = (await client`
          SELECT to_regclass(${LEGACY_BACKFILL_FINGERPRINT_TABLE}) AS r
        `) as Array<{ r: string | null }>;
        if (!fingerprint[0]?.r) {
          throw new Error(
            `[migrate] Legacy DB detected (public.tenants exists) but fingerprint table ` +
              `${LEGACY_BACKFILL_FINGERPRINT_TABLE} is missing — the DB predates migration ` +
              `${LEGACY_BACKFILL_TIP_TAG}. Refusing to seed __drizzle_migrations: entries past ` +
              `the DB's true tip would be silently skipped (including security-hardening ` +
              `migrations). Reconcile the schema manually, then re-run migrations.`,
          );
        }
        const backfillEntries = selectLegacyBackfillEntries(journal);
        logger.info(
          {
            details: [
              `[migrate] Legacy DB detected — seeding __drizzle_migrations with ${backfillEntries.length} ` +
                `entries through ${LEGACY_BACKFILL_TIP_TAG}; the migrator will apply the remaining ` +
                `${journal.entries.length - backfillEntries.length} journal entrie(s) normally`,
            ],
          },
          "[Login:migrate] info",
        );
        for (const entry of backfillEntries) {
          const hash = hashMigration(entry.tag);
          await client`
            INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at")
            VALUES (${hash}, ${entry.when})
          `;
        }
      }

      const beforeCount = (
        (await client`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`) as Array<{
          n: number;
        }>
      )[0].n;

      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

      const afterRows = (await client`
        SELECT hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY id ASC
      `) as Array<{ hash: string; created_at: string | number | null }>;

      const newRows = afterRows.slice(beforeCount);
      const tagByHash = new Map<string, string>();
      for (const entry of journal.entries)
        tagByHash.set(hashMigration(entry.tag), entry.tag);
      const applied = newRows.map((r) => tagByHash.get(r.hash) ?? r.hash);

      return { applied };
    } finally {
      await client`SELECT pg_advisory_unlock(hashtextextended(${ADVISORY_LOCK_KEY}, 0))`;
    }
  } finally {
    await client.end();
  }
}
