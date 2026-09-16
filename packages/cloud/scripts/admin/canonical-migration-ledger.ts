/** Dependency-light, read-only canonical Cloud migration ledger validation. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const HASH_IDENTITY_ENFORCEMENT_TAG =
  "0194_job_execution_interruptions_catalog_guard";
const MIGRATIONS_DIR =
  [
    path.join(process.cwd(), "packages/cloud/shared/src/db/migrations"),
    path.join(process.cwd(), "src/db/migrations"),
  ].find((candidate) =>
    existsSync(path.join(candidate, "meta/_journal.json")),
  ) ?? path.join(process.cwd(), "packages/cloud/shared/src/db/migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta/_journal.json");

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface Migration {
  entry: JournalEntry;
  hash: string;
  statements: string[];
}

export interface AppliedMigration {
  id: number;
  hash: string;
  created_at: string | number | bigint | null;
}

export interface ValidatedMigrationLedger {
  lastAppliedJournalIndex: number;
}

export interface CanonicalRelationQueryClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

async function readJournal(): Promise<Journal> {
  return JSON.parse(await readFile(JOURNAL_PATH, "utf8")) as Journal;
}

async function readMigration(entry: JournalEntry): Promise<Migration> {
  const migrationPath = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
  const sql = await readFile(migrationPath, "utf8");
  return {
    entry,
    hash: createHash("sha256").update(sql).digest("hex"),
    statements: sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean),
  };
}

/** Loads the exact repository journal and migration SQL hashes without mutation. */
export async function loadCanonicalMigrations(): Promise<Migration[]> {
  const journal = await readJournal();
  return Promise.all(journal.entries.map((entry) => readMigration(entry)));
}

export function createdAtValue(migration: AppliedMigration): number | null {
  if (migration.created_at === null) return null;
  const value = Number(migration.created_at);
  return Number.isFinite(value) ? value : null;
}

export function validateAppliedMigrationLedger(
  applied: AppliedMigration[],
  migrations: Migration[],
): ValidatedMigrationLedger {
  if (applied.length > migrations.length) {
    throw new Error(
      `Migration ledger contains ${applied.length} rows but this checkout defines only ${migrations.length}`,
    );
  }

  const migrationByCreatedAt = new Map<
    number,
    { journalIndex: number; migration: Migration }
  >();
  for (const [journalIndex, migration] of migrations.entries()) {
    const createdAt = migration.entry.when;
    if (migrationByCreatedAt.has(createdAt)) {
      throw new Error(
        `Migration journal contains duplicate created_at=${createdAt}`,
      );
    }
    migrationByCreatedAt.set(createdAt, { journalIndex, migration });
  }

  const hashIdentityEnforcementIndex = migrations.findIndex(
    (migration) => migration.entry.tag === HASH_IDENTITY_ENFORCEMENT_TAG,
  );
  if (hashIdentityEnforcementIndex === -1) {
    throw new Error(
      `Migration journal is missing hash enforcement checkpoint ${HASH_IDENTITY_ENFORCEMENT_TAG}`,
    );
  }

  const seenCreatedAt = new Set<number>();
  const appliedJournalIndexes = new Set<number>();
  let lastAppliedJournalIndex = -1;
  let lastEnforcedJournalIndex = hashIdentityEnforcementIndex - 1;
  let hashEnforcementStarted = false;
  for (const row of applied) {
    const createdAt = createdAtValue(row);
    if (createdAt === null) {
      throw new Error(
        `Migration ledger row id=${row.id} has an invalid created_at value`,
      );
    }
    if (seenCreatedAt.has(createdAt)) {
      throw new Error(
        `Migration ledger contains duplicate created_at=${createdAt}`,
      );
    }
    seenCreatedAt.add(createdAt);
    const matched = migrationByCreatedAt.get(createdAt);
    if (!matched) {
      throw new Error(
        `Migration ledger row id=${row.id} has no matching journal entry for created_at=${createdAt}`,
      );
    }
    if (
      matched.journalIndex >= hashIdentityEnforcementIndex &&
      row.hash !== matched.migration.hash
    ) {
      throw new Error(
        `Migration ledger hash mismatch for ${matched.migration.entry.tag}: expected ${matched.migration.hash}, found ${row.hash}`,
      );
    }
    if (matched.journalIndex >= hashIdentityEnforcementIndex) {
      if (matched.journalIndex <= lastEnforcedJournalIndex) {
        throw new Error(
          `Migration ledger is out of immutable journal order at row id=${row.id}: ${matched.migration.entry.tag} follows journal index ${lastEnforcedJournalIndex}`,
        );
      }
      hashEnforcementStarted = true;
      lastEnforcedJournalIndex = matched.journalIndex;
    } else if (hashEnforcementStarted) {
      throw new Error(
        `Historical migration ${matched.migration.entry.tag} appears after hash enforcement checkpoint ${HASH_IDENTITY_ENFORCEMENT_TAG}`,
      );
    }
    appliedJournalIndexes.add(matched.journalIndex);
    lastAppliedJournalIndex = Math.max(
      lastAppliedJournalIndex,
      matched.journalIndex,
    );
  }

  for (
    let journalIndex = hashIdentityEnforcementIndex;
    journalIndex <= lastAppliedJournalIndex;
    journalIndex++
  ) {
    const migration = migrations[journalIndex];
    if (!migration) {
      throw new Error(`Migration journal is missing index ${journalIndex}`);
    }
    if (!appliedJournalIndexes.has(journalIndex)) {
      throw new Error(
        `Migration ledger is missing required journal entry ${migration.entry.tag}`,
      );
    }
  }
  return { lastAppliedJournalIndex };
}

export const CANONICAL_CLOUD_RELATIONS = [
  "apps",
  "organizations",
  "users",
  "api_keys",
] as const;

/** Rejects a non-empty ledger whose baseline application relations drifted. */
export async function assertAppliedLedgerHasCanonicalRelations(
  client: CanonicalRelationQueryClient,
): Promise<void> {
  const result = await client.query<Record<string, boolean>>(`
    SELECT
      to_regclass('public.apps') IS NOT NULL AS apps,
      to_regclass('public.organizations') IS NOT NULL AS organizations,
      to_regclass('public.users') IS NOT NULL AS users,
      to_regclass('public.api_keys') IS NOT NULL AS api_keys
  `);
  const row = result.rows[0];
  const presence = CANONICAL_CLOUD_RELATIONS.map((relation) => ({
    present: row?.[relation] === true,
    relation,
  }));
  process.stdout.write(
    `[db:migrate] canonical relation presence: ${presence
      .map(
        ({ present, relation }) =>
          `${relation}=${present ? "present" : "missing"}`,
      )
      .join(" ")}\n`,
  );
  if (presence.some(({ present }) => !present)) {
    throw new Error(
      "Migration ledger is non-empty but canonical application relations are missing",
    );
  }
}
