/**
 * Applies the cloud DB's Drizzle SQL migrations (packages/cloud/shared/src/db/
 * migrations) under a database-wide advisory lock with per-statement failure
 * diagnostics instead of drizzle-kit's opaque errors. Ledger validation and
 * bounded lock retries make concurrent deploys serialize without accepting
 * partial, duplicated, or reordered migration history. The protected database
 * identity gate runs on this same locked session before the first DDL. Invoked
 * as `db:cloud:migrate` at the repo root and `db:migrate` in packages/cloud/shared,
 * including the deploy pipeline's migrate-db gate; enforces TLS for remote
 * databases.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { enforceTlsForRemote } from "@elizaos/cloud-shared/db/client";
import { convergeAgentSandboxSchema } from "@elizaos/cloud-shared/db/ensure-agent-sandbox-schema";
import { createMigrationClientSandboxExecutor } from "@elizaos/cloud-shared/db/migration-sandbox-schema-executor";
import pg from "pg";
import {
  type CleanupFailure,
  runCleanupSteps,
  runWithCleanup,
} from "./error-preserving-cleanup";
import {
  type DatabaseIdentityConfig,
  type IdentityPreflightResult,
  publishDatabaseIdentityResult,
  readDatabaseIdentityConfig,
  runDatabaseIdentityPreflight,
} from "./preflight-database-identity";

const { Client } = pg;

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATION_ADVISORY_LOCK_KEY = "eliza:cloud:migrations:v1";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_MAX_ATTEMPTS = 5;
const DEFAULT_LOCK_RETRY_BASE_MS = 250;
const DEFAULT_LOCK_RETRY_MAX_MS = 2_000;
const MIGRATIONS_DIR =
  [
    path.join(process.cwd(), "packages/cloud/shared/src/db/migrations"),
    path.join(process.cwd(), "src/db/migrations"),
  ].find((candidate) =>
    existsSync(path.join(candidate, "meta/_journal.json")),
  ) ?? path.join(process.cwd(), "packages/cloud/shared/src/db/migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta/_journal.json");

interface JournalEntry {
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

interface Migration {
  entry: JournalEntry;
  hash: string;
  statements: string[];
}

interface AppliedMigration {
  id: number;
  hash: string;
  created_at: string | number | bigint | null;
}

interface DatabaseError extends Error {
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

interface MigrationClient {
  backend: "pglite" | "postgres";
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

interface LockRetryOptions {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

interface ValidatedMigrationLedger {
  lastAppliedJournalIndex: number;
}

type IdentityResultReporter = (
  config: DatabaseIdentityConfig,
  result: IdentityPreflightResult,
) => Promise<void>;

type PostMigrationConvergence = (client: MigrationClient) => Promise<void>;

/** Executes the historical agent-sandbox drift repair on the locked migration session. */
export async function convergeAgentSandboxSchemaOnMigrationClient(
  migrationClient: MigrationClient,
): Promise<void> {
  // The migration-only adapter owns SQL rendering without pulling PgDialect
  // into the Worker-facing schema guard module.
  await convergeAgentSandboxSchema(
    createMigrationClientSandboxExecutor((text, params) =>
      migrationClient.query(text, params),
    ),
  );
}

// Historical SQL files were edited after deployment, so their stored hashes
// and some deployed schemas have no matching ledger row. The catalog-guard
// migration is the first immutable checkpoint owned by this runner; hash,
// order, and completeness identity are enforced from this entry forward.
const HASH_IDENTITY_ENFORCEMENT_TAG =
  "0194_job_execution_interruptions_catalog_guard";
const USAGE_QUOTAS_RELEASE_BARRIER_TAGS = [
  "0282_drop_unused_usage_quotas_table",
  "0282_01_restore_usage_quotas_compatibility",
] as const;

type MigrationReleaseBarrierDecision =
  | { action: "continue" }
  | { action: "pause"; stopBeforeJournalIndex: number };

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

function createdAtValue(migration: AppliedMigration): number | null {
  if (migration.created_at === null) return null;

  const value = Number(migration.created_at);
  return Number.isFinite(value) ? value : null;
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function lockRetryOptions(): LockRetryOptions {
  const options = {
    timeoutMs: readPositiveInteger(
      "MIGRATION_LOCK_TIMEOUT_MS",
      DEFAULT_LOCK_TIMEOUT_MS,
    ),
    maxAttempts: readPositiveInteger(
      "MIGRATION_LOCK_MAX_ATTEMPTS",
      DEFAULT_LOCK_MAX_ATTEMPTS,
    ),
    baseDelayMs: readPositiveInteger(
      "MIGRATION_LOCK_RETRY_BASE_MS",
      DEFAULT_LOCK_RETRY_BASE_MS,
    ),
    maxDelayMs: readPositiveInteger(
      "MIGRATION_LOCK_RETRY_MAX_MS",
      DEFAULT_LOCK_RETRY_MAX_MS,
    ),
  };
  if (options.maxDelayMs < options.baseDelayMs) {
    throw new Error(
      "MIGRATION_LOCK_RETRY_MAX_MS must be at least MIGRATION_LOCK_RETRY_BASE_MS",
    );
  }
  return options;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as DatabaseError).code;
  return typeof code === "string" ? code : undefined;
}

function isLockTimeout(error: unknown): boolean {
  return databaseErrorCode(error) === "55P03";
}

function retryDelayMs(attempt: number, options: LockRetryOptions): number {
  const ceiling = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.max(1, Math.floor(ceiling * (0.5 + Math.random() * 0.5)));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeStatement(statement: string): string {
  return statement.replace(/\s+/g, " ").slice(0, 500);
}

function formatDatabaseError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const databaseError = error as DatabaseError;
  const details = [
    `message=${databaseError.message}`,
    databaseError.code ? `code=${databaseError.code}` : null,
    databaseError.detail ? `detail=${databaseError.detail}` : null,
    databaseError.hint ? `hint=${databaseError.hint}` : null,
    databaseError.position ? `position=${databaseError.position}` : null,
    databaseError.schema ? `schema=${databaseError.schema}` : null,
    databaseError.table ? `table=${databaseError.table}` : null,
    databaseError.column ? `column=${databaseError.column}` : null,
    databaseError.constraint ? `constraint=${databaseError.constraint}` : null,
  ].filter(Boolean);

  return details.join(" ");
}

function reportMigrationCleanupFailure(failure: CleanupFailure): void {
  const context = failure.primaryFailure
    ? " while preserving the primary migration failure"
    : "";
  console.error(
    `[db:migrate] ${failure.label} failed${context}: ${formatDatabaseError(failure.cleanupError)}`,
  );
}

async function ensureMigrationsTable(client: MigrationClient): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

async function getAppliedMigrations(
  client: MigrationClient,
): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(`
    SELECT id, hash, created_at
    FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
    ORDER BY id ASC
  `);

  return result.rows;
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

  const seenCreatedAt = new Set<number>();
  const appliedJournalIndexes = new Set<number>();
  const hashIdentityEnforcementIndex = migrations.findIndex(
    (migration) => migration.entry.tag === HASH_IDENTITY_ENFORCEMENT_TAG,
  );
  if (hashIdentityEnforcementIndex === -1) {
    throw new Error(
      `Migration journal is missing hash enforcement checkpoint ${HASH_IDENTITY_ENFORCEMENT_TAG}`,
    );
  }
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
    // Historical deployments used both journal-order and timestamp-order
    // runners, so row id cannot authenticate ordering before the checkpoint.
    // From the checkpoint forward this runner owns a single append-only order.
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

/**
 * Fences the two-step usage-quotas repair while the compatibility Worker is
 * being rolled out. Any validated ledger before 0282 may apply its safe prefix
 * but pauses before the drop so the deploy can continue without exposing the
 * old Worker to the missing table. Environments that already recorded 0282
 * must proceed directly to the restoring 0282_01 migration. Any other suffix is
 * unsafe and fails closed before the first pending migration is applied.
 */
export function evaluateMigrationReleaseBarrier(
  migrations: Migration[],
  lastAppliedJournalIndex: number,
): MigrationReleaseBarrierDecision {
  const journalTags = migrations.map((migration) => migration.entry.tag);
  const barrierIndexes = USAGE_QUOTAS_RELEASE_BARRIER_TAGS.map((tag) =>
    journalTags.reduce<number[]>((indexes, candidate, index) => {
      if (candidate === tag) indexes.push(index);
      return indexes;
    }, []),
  );
  const presentBarrierTags = barrierIndexes.filter(
    (indexes) => indexes.length > 0,
  ).length;

  // Older synthetic histories and checkouts pre-dating 0282 have no barrier.
  if (presentBarrierTags === 0) return { action: "continue" };

  const expectedSuffix = USAGE_QUOTAS_RELEASE_BARRIER_TAGS.join(", ");
  if (barrierIndexes.some((indexes) => indexes.length !== 1)) {
    throw new Error(
      `Migration release barrier requires exactly one of each suffix entry (${expectedSuffix})`,
    );
  }

  const dropIndex = barrierIndexes[0]?.[0];
  const restoreIndex = barrierIndexes[1]?.[0];
  const expectedDropIndex = migrations.length - 2;
  const expectedRestoreIndex = migrations.length - 1;
  if (
    dropIndex !== expectedDropIndex ||
    restoreIndex !== expectedRestoreIndex
  ) {
    const actualSuffix = journalTags
      .slice(Math.max(0, Math.min(dropIndex ?? 0, restoreIndex ?? 0)))
      .join(", ");
    throw new Error(
      `Migration release barrier expected journal suffix (${expectedSuffix}); found (${actualSuffix || "empty"})`,
    );
  }

  if (lastAppliedJournalIndex < dropIndex) {
    return { action: "pause", stopBeforeJournalIndex: dropIndex };
  }

  if (lastAppliedJournalIndex === dropIndex) {
    const pendingTags = journalTags.slice(lastAppliedJournalIndex + 1);
    if (
      pendingTags.length !== 1 ||
      pendingTags[0] !== USAGE_QUOTAS_RELEASE_BARRIER_TAGS[1]
    ) {
      throw new Error(
        `Migration release barrier expected only ${USAGE_QUOTAS_RELEASE_BARRIER_TAGS[1]} after ledgered 0282; found (${pendingTags.join(", ") || "empty"})`,
      );
    }
  }

  return { action: "continue" };
}

async function acquireMigrationLock(
  client: MigrationClient,
  options: LockRetryOptions,
): Promise<void> {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    await client.query("SELECT set_config('lock_timeout', $1, false)", [
      `${options.timeoutMs}ms`,
    ]);
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        MIGRATION_ADVISORY_LOCK_KEY,
      ]);
      await client.query("SELECT set_config('lock_timeout', '0', false)");
      console.log(`[db:migrate] acquired migration lock on attempt ${attempt}`);
      return;
    } catch (error) {
      if (!isLockTimeout(error)) throw error;
      if (attempt === options.maxAttempts) {
        console.error(
          `[db:migrate] migration lock acquisition exhausted ${options.maxAttempts} attempts`,
        );
        throw error;
      }
      const delayMs = retryDelayMs(attempt, options);
      console.warn(
        `[db:migrate] migration lock busy on attempt ${attempt}/${options.maxAttempts}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
}

async function releaseMigrationLock(client: MigrationClient): Promise<void> {
  const result = await client.query<{ unlocked: boolean }>(
    "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
    [MIGRATION_ADVISORY_LOCK_KEY],
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new Error(
      "Migration advisory lock was not held by this session at release",
    );
  }
  console.log("[db:migrate] released migration lock");
}

/** Applies one journal migration atomically and retries only after rollback. */
export async function applyMigration(
  client: MigrationClient,
  migration: Migration,
  options: LockRetryOptions,
): Promise<void> {
  const { entry, statements, hash } = migration;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    console.log(
      `[db:migrate] applying ${entry.tag} (${statements.length} statements, attempt ${attempt}/${options.maxAttempts})`,
    );
    await client.query("BEGIN");

    try {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${options.timeoutMs}ms`,
      ]);
      for (const [index, statement] of statements.entries()) {
        try {
          await client.query(statement);
        } catch (error) {
          console.error(
            `[db:migrate] failed ${entry.tag} statement ${index + 1}/${statements.length}`,
          );
          console.error(`[db:migrate] sql: ${summarizeStatement(statement)}`);
          console.error(`[db:migrate] error: ${formatDatabaseError(error)}`);
          throw error;
        }
      }

      await client.query(
        `INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (hash, created_at) VALUES ($1, $2)`,
        [hash, entry.when],
      );
      await client.query("COMMIT");
      return;
    } catch (error) {
      await runCleanupSteps(
        [
          {
            label: `rollback for ${entry.tag}`,
            run: async () => {
              await client.query("ROLLBACK");
            },
          },
        ],
        reportMigrationCleanupFailure,
        { error },
      );
      if (!isLockTimeout(error)) throw error;
      if (attempt === options.maxAttempts) {
        console.error(
          `[db:migrate] ${entry.tag} exhausted ${options.maxAttempts} lock-timeout attempts`,
        );
        throw error;
      }
      const delayMs = retryDelayMs(attempt, options);
      console.warn(
        `[db:migrate] ${entry.tag} lock timeout on attempt ${attempt}/${options.maxAttempts}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
}

async function createPGliteClient(url: string): Promise<MigrationClient> {
  const stripped = url.slice("pglite://".length);
  const dataDir = !stripped || stripped === "memory" ? undefined : stripped;
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const db = await PGlite.create({ dataDir, extensions: { vector } });

  return {
    backend: "pglite",
    // Migrations contain multi-statement chunks (drizzle does not split on `;`
    // for non-breakpoint segments). PGlite's prepared `query()` rejects those,
    // so route parameter-less SQL through `exec()` and bound queries through
    // `query()`. Result rows from `exec()` come back as an array per statement;
    // the migrate harness only reads rows from the bound queries it issues.
    query: async <T>(text: string, params?: unknown[]) => {
      if (params && params.length > 0) {
        const result = await db.query<T>(text, params as unknown[]);
        return { rows: result.rows };
      }
      const results = await db.exec(text);
      const last = results[results.length - 1];
      return { rows: (last?.rows as T[] | undefined) ?? [] };
    },
    end: () => db.close(),
  };
}

async function createPgClient(url: string): Promise<MigrationClient> {
  console.log("[db:migrate] preparing PostgreSQL client");
  const { url: clientUrl, ssl: clientSsl } = enforceTlsForRemote(url);
  const client = new Client({
    connectionString: clientUrl,
    ...(clientSsl ? { ssl: clientSsl } : {}),
  });
  console.log("[db:migrate] connecting PostgreSQL client");
  await client.connect();
  console.log("[db:migrate] PostgreSQL client connected");
  return {
    backend: "postgres",
    query: async <T>(text: string, params?: unknown[]) => {
      const result = await client.query<Record<string, unknown>>(text, params);
      return { rows: result.rows as T[] };
    },
    end: () => client.end(),
  };
}

/** Runs the validated migration plan and owns lock and client teardown. */
export async function runMigrations(
  client: MigrationClient,
  migrations: Migration[],
  retryOptions: LockRetryOptions,
  identityConfig?: DatabaseIdentityConfig,
  reportIdentityResult?: IdentityResultReporter,
  postMigrationConvergence?: PostMigrationConvergence,
): Promise<void> {
  let lockHeld = false;
  await runWithCleanup(
    async () => {
      if (client.backend === "postgres") {
        console.log("[db:migrate] acquiring migration lock");
        await acquireMigrationLock(client, retryOptions);
        lockHeld = true;
      } else {
        console.log(
          "[db:migrate] PGlite backend uses its single-writer database lock",
        );
      }
      if (identityConfig) {
        const identityResult = await runDatabaseIdentityPreflight(
          identityConfig,
          client,
        );
        await reportIdentityResult?.(identityConfig, identityResult);
      }
      await ensureMigrationsTable(client);

      const applied = await getAppliedMigrations(client);
      const validatedLedger = validateAppliedMigrationLedger(
        applied,
        migrations,
      );
      const lastApplied = applied.at(-1);
      const lastAppliedCreatedAt = lastApplied
        ? createdAtValue(lastApplied)
        : null;
      console.log(
        `[db:migrate] last applied migration: ${
          lastAppliedCreatedAt === null
            ? "none"
            : `${lastAppliedCreatedAt} (${lastApplied?.hash.slice(0, 12)})`
        }`,
      );

      const releaseBarrier = evaluateMigrationReleaseBarrier(
        migrations,
        validatedLedger.lastAppliedJournalIndex,
      );
      const pending = migrations.slice(
        validatedLedger.lastAppliedJournalIndex + 1,
        releaseBarrier.action === "pause"
          ? releaseBarrier.stopBeforeJournalIndex
          : undefined,
      );
      console.log(
        `[db:migrate] pending migrations: ${migrations.length - validatedLedger.lastAppliedJournalIndex - 1}`,
      );
      if (releaseBarrier.action === "pause") {
        console.log(
          `[db:migrate] release barrier permits ${pending.length} safe pending migrations before 0282`,
        );
      }

      for (const migration of pending) {
        await applyMigration(client, migration, retryOptions);
      }

      await postMigrationConvergence?.(client);

      if (releaseBarrier.action === "pause") {
        console.warn(
          `[db:migrate] release barrier paused before ${USAGE_QUOTAS_RELEASE_BARRIER_TAGS[0]}; deploy the compatibility Worker before advancing the migration ledger`,
        );
        return;
      }

      console.log("[db:migrate] migrations complete");
    },
    [
      {
        label: "migration advisory unlock",
        run: async () => {
          if (lockHeld) await releaseMigrationLock(client);
        },
      },
      { label: "database client close", run: () => client.end() },
    ],
    reportMigrationCleanupFailure,
  );
}

async function main(): Promise<void> {
  const environment: Readonly<Record<string, string | undefined>> = process.env;
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  const journal = await readJournal();
  const migrations = await Promise.all(
    journal.entries.map((entry) => readMigration(entry)),
  );
  const retryOptions = lockRetryOptions();
  const configuredIdentityMode =
    environment.DATABASE_IDENTITY_GATE_MODE?.trim().toLowerCase();
  const identityConfig =
    environment.DATABASE_IDENTITY_ENVIRONMENT !== undefined ||
    (configuredIdentityMode !== undefined && configuredIdentityMode !== "off")
      ? readDatabaseIdentityConfig(environment)
      : undefined;

  const client: MigrationClient = databaseUrl.startsWith("pglite://")
    ? await createPGliteClient(databaseUrl)
    : await createPgClient(databaseUrl);

  await runMigrations(
    client,
    migrations,
    retryOptions,
    identityConfig,
    async (config, result) => {
      try {
        await publishDatabaseIdentityResult(config, result);
      } catch (error) {
        // error-policy:J1 report mode must not turn an evidence-output failure
        // into permission to skip or block the migration identity decision.
        if (config.mode !== "report") throw error;
        process.stdout.write(
          "::warning::database identity report output unavailable; inspect protected operator logs\n",
        );
      }
    },
    convergeAgentSandboxSchemaOnMigrationClient,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[db:migrate] fatal: ${formatDatabaseError(error)}`);
    if (error instanceof Error && typeof error.stack === "string") {
      const frames = error.stack
        .split("\n")
        .slice(1, 13)
        .filter((line) => line.trimStart().startsWith("at "));
      if (frames.length > 0) {
        console.error(`[db:migrate] stack frames:\n${frames.join("\n")}`);
      }
    }
    process.exit(1);
  });
}
