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
import { enforceTlsForRemote } from "@elizaos/cloud-shared/db/client";
import { convergeAgentSandboxSchema } from "@elizaos/cloud-shared/db/ensure-agent-sandbox-schema";
import { createMigrationClientSandboxExecutor } from "@elizaos/cloud-shared/db/migration-sandbox-schema-executor";
import pg from "pg";
import {
  type AppliedMigration,
  assertAppliedLedgerHasCanonicalRelations,
  createdAtValue,
  loadCanonicalMigrations,
  type Migration,
  validateAppliedMigrationLedger,
} from "./canonical-migration-ledger";
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

export type {
  AppliedMigration,
  JournalEntry,
  Migration,
  ValidatedMigrationLedger,
} from "./canonical-migration-ledger";
export {
  assertAppliedLedgerHasCanonicalRelations,
  createdAtValue,
  loadCanonicalMigrations,
  validateAppliedMigrationLedger,
} from "./canonical-migration-ledger";

const { Client } = pg;

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATION_ADVISORY_LOCK_KEY = "eliza:cloud:migrations:v1";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_MAX_ATTEMPTS = 5;
const DEFAULT_LOCK_RETRY_BASE_MS = 250;
const DEFAULT_LOCK_RETRY_MAX_MS = 2_000;
interface DatabaseError extends Error {
  code?: string;
  position?: string;
}

export interface MigrationClient {
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

const USAGE_QUOTAS_RELEASE_BARRIER_TAGS = [
  "0282_drop_unused_usage_quotas_table",
  "0282_01_restore_usage_quotas_compatibility",
] as const;

type MigrationReleaseBarrierDecision =
  | { action: "continue"; atomicPairStartIndex?: number }
  | { action: "pause"; stopBeforeJournalIndex: number };

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

const POSTGRES_SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const POSTGRES_POSITION_PATTERN = /^[1-9][0-9]{0,9}$/;

function allowlistedDatabaseField(
  value: unknown,
  pattern: RegExp,
): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/**
 * Format only bounded PostgreSQL metadata that cannot contain row values.
 *
 * PostgreSQL's `message`, `detail`, and `hint` fields are deliberately absent:
 * JSON parse failures copy the offending legacy token into `detail`, while
 * other error classes may interpolate provider or row data into any of the
 * three. This formatter is shared by statement, cleanup, and fatal stderr so a
 * parent process using inherited stdio cannot accidentally re-expose them.
 */
function formatDatabaseError(error: unknown): string {
  let sqlState: string | undefined;
  let position: string | undefined;
  try {
    const databaseError =
      error instanceof Error ? (error as DatabaseError) : null;
    sqlState = allowlistedDatabaseField(
      databaseError?.code,
      POSTGRES_SQLSTATE_PATTERN,
    );
    position = allowlistedDatabaseField(
      databaseError?.position,
      POSTGRES_POSITION_PATTERN,
    );
  } catch {
    // error-policy:J3 hostile error accessors yield the static diagnostic.
  }
  const details = [
    "code=DATABASE_OPERATION_FAILED",
    sqlState ? `database_code=${sqlState}` : null,
    position ? `position=${position}` : null,
  ].filter(Boolean);

  return details.join(" ");
}

/** Emits the production fatal boundary without serializing the database error. */
function reportMigrationFatalFailure(error: unknown): void {
  console.error(`[db:migrate] fatal: ${formatDatabaseError(error)}`);
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

/**
 * Proves that an empty ledger belongs to a database with no application
 * relations. The migration lock and this query share one session, so a wiped
 * or truncated ledger cannot impersonate a new database and replay destructive
 * historical DDL over a live schema.
 */
async function assertEmptyLedgerDatabaseIsFresh(
  client: MigrationClient,
): Promise<void> {
  const result = await client.query<{ has_user_relations: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND NOT (
          namespace.nspname = '${MIGRATIONS_SCHEMA}'
          AND relation.relname IN (
            '${MIGRATIONS_TABLE}',
            '${MIGRATIONS_TABLE}_id_seq'
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid = 'pg_catalog.pg_class'::regclass
            AND dependency.objid = relation.oid
            AND dependency.deptype = 'e'
        )
    ) AS has_user_relations
  `);
  if (
    result.rows.length !== 1 ||
    typeof result.rows[0]?.has_user_relations !== "boolean"
  ) {
    throw new Error(
      "Fresh-database migration proof returned an invalid catalog result",
    );
  }
  if (result.rows[0].has_user_relations) {
    console.error(
      "[db:migrate] refusing empty-ledger replay because application relations already exist",
    );
    throw new Error(
      "Migration ledger is empty but the database contains application relations; refusing to replay historical migrations",
    );
  }
}

/**
 * Fences the two-step usage-quotas repair while the compatibility Worker is
 * being rolled out (#23829 Phase A, #23859). What the barrier protects is a
 * LIVE deployment: a Worker already serving traffic against this database must
 * never run against the window between 0282 (drop) and 0282_01 (restore). So a
 * validated ledger that already carries applied migrations may apply its safe
 * prefix but pauses before the drop, and the deploy continues without exposing
 * the currently-served Worker to the missing table.
 *
 * An empty ledger alone is not evidence of a fresh database: a live database
 * can have its ledger truncated or lost. The runner separately proves under
 * the migration lock that no application relations exist before taking the
 * empty-ledger path. It also applies the drop, restore, and both ledger rows in
 * one transaction, so no concurrent Worker can observe the missing-table
 * window even if the freshness assumption is ever weakened accidentally.
 *
 * Environments that already recorded 0282 must proceed directly to the
 * restoring 0282_01 migration. Any other suffix is unsafe and fails closed
 * before the first pending migration is applied.
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
  // Anchor on ADJACENCY, not on the journal tail. Requiring the pair to be the
  // last two entries means the next migration anyone appends makes this throw
  // for every target, including fully-migrated ones — a repo-wide stop-the-
  // world. What the barrier actually needs is that the restore immediately
  // follows the drop, so no other migration can interleave between them.
  if (
    dropIndex === undefined ||
    restoreIndex === undefined ||
    restoreIndex !== dropIndex + 1
  ) {
    const actualSuffix = journalTags
      .slice(Math.max(0, Math.min(dropIndex ?? 0, restoreIndex ?? 0)))
      .join(", ");
    throw new Error(
      `Migration release barrier expected adjacent journal entries (${expectedSuffix}); found (${actualSuffix || "empty"})`,
    );
  }

  // runMigrations proves an empty ledger belongs to a relation-free database
  // before honoring this plan. The explicit index also makes atomic pairing a
  // required execution contract rather than an adjacency assumption.
  if (lastAppliedJournalIndex === -1) {
    return { action: "continue", atomicPairStartIndex: dropIndex };
  }

  if (lastAppliedJournalIndex < dropIndex) {
    return { action: "pause", stopBeforeJournalIndex: dropIndex };
  }

  if (lastAppliedJournalIndex === dropIndex) {
    // Only the NEXT entry has to be the restore — later migrations are none of
    // this barrier's business, and demanding it be the only pending one is the
    // same tail-pinning mistake one layer down.
    const nextTag = journalTags[lastAppliedJournalIndex + 1];
    if (nextTag !== USAGE_QUOTAS_RELEASE_BARRIER_TAGS[1]) {
      throw new Error(
        `Migration release barrier expected ${USAGE_QUOTAS_RELEASE_BARRIER_TAGS[1]} immediately after ledgered 0282; found (${nextTag ?? "empty"})`,
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

/** Applies one or more journal entries in one transaction and ledger commit. */
async function applyMigrationBatch(
  client: MigrationClient,
  migrations: readonly Migration[],
  options: LockRetryOptions,
): Promise<void> {
  if (migrations.length === 0) {
    throw new Error("Migration batch must contain at least one journal entry");
  }
  const batchLabel = migrations
    .map((migration) => migration.entry.tag)
    .join(" + ");

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    await client.query("BEGIN");

    try {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${options.timeoutMs}ms`,
      ]);
      for (const { entry, statements, hash } of migrations) {
        console.log(
          `[db:migrate] applying ${entry.tag} (${statements.length} statements, attempt ${attempt}/${options.maxAttempts})`,
        );
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
      }
      await client.query("COMMIT");
      return;
    } catch (error) {
      await runCleanupSteps(
        [
          {
            label: `rollback for ${batchLabel}`,
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
          `[db:migrate] ${batchLabel} exhausted ${options.maxAttempts} lock-timeout attempts`,
        );
        throw error;
      }
      const delayMs = retryDelayMs(attempt, options);
      console.warn(
        `[db:migrate] ${batchLabel} lock timeout on attempt ${attempt}/${options.maxAttempts}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
}

/** Applies one journal migration atomically and retries only after rollback. */
export async function applyMigration(
  client: MigrationClient,
  migration: Migration,
  options: LockRetryOptions,
): Promise<void> {
  await applyMigrationBatch(client, [migration], options);
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
      if (applied.length === 0) {
        await assertEmptyLedgerDatabaseIsFresh(client);
      }
      const validatedLedger = validateAppliedMigrationLedger(
        applied,
        migrations,
      );
      if (client.backend === "postgres" && applied.length > 0) {
        await assertAppliedLedgerHasCanonicalRelations(client);
      }
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

      for (
        let pendingIndex = 0;
        pendingIndex < pending.length;
        pendingIndex++
      ) {
        const journalIndex =
          validatedLedger.lastAppliedJournalIndex + 1 + pendingIndex;
        if (
          releaseBarrier.action === "continue" &&
          releaseBarrier.atomicPairStartIndex === journalIndex
        ) {
          const atomicPair = pending.slice(pendingIndex, pendingIndex + 2);
          if (
            atomicPair.length !== 2 ||
            atomicPair[0]?.entry.tag !== USAGE_QUOTAS_RELEASE_BARRIER_TAGS[0] ||
            atomicPair[1]?.entry.tag !== USAGE_QUOTAS_RELEASE_BARRIER_TAGS[1]
          ) {
            throw new Error(
              "Migration release barrier atomic pair no longer matches the validated journal",
            );
          }
          await applyMigrationBatch(client, atomicPair, retryOptions);
          pendingIndex += 1;
          continue;
        }
        const migration = pending[pendingIndex];
        if (!migration)
          throw new Error("Migration plan contains an empty entry");
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

  const migrations = await loadCanonicalMigrations();
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
    reportMigrationFatalFailure(error);
    process.exit(1);
  });
}
