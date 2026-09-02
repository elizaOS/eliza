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
const NONTRANSACTIONAL_CONCURRENT_INDEX_DIRECTIVE =
  "-- migrate-with-diagnostics: nontransactional-concurrent-indexes";
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

interface ConcurrentIndexStatement {
  definitionTail: string;
  indexName: string;
  isUnique: boolean;
  statement: string;
  tableName: string;
}

type MigrationExecutionPlan =
  | { mode: "transactional" }
  | {
      mode: "nontransactional-concurrent-indexes";
      statements: ConcurrentIndexStatement[];
    };

interface ConcurrentIndexState {
  constraint_owned: boolean | null;
  exclusion: boolean | null;
  extension_owned: boolean | null;
  index_namespace: string | null;
  index_oid: string | null;
  indexed_table_oid: string | null;
  live: boolean | null;
  migration_marker: string | null;
  partition_attached: boolean | null;
  primary: boolean | null;
  ready: boolean | null;
  relation_kind: string | null;
  target_namespace: string | null;
  target_oid: string | null;
  target_relation_kind: string | null;
  table_name: string | null;
  valid: boolean | null;
}

interface ConcurrentIndexDefinition {
  canonical_definition: string;
}

interface LockTimeoutSetting {
  lock_timeout: string;
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

function statementWithoutFullLineCommentsForDetection(
  statement: string,
): string {
  return statement
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
}

/**
 * Parses the deliberately narrow SQL admitted outside a transaction.
 *
 * Completed or invalid unmarked indexes are replayed only when PostgreSQL's
 * canonical catalog shape matches the migration exactly. The source may retain
 * `IF NOT EXISTS` for direct schema-fixture replay, but the execution statement
 * deliberately removes it: a same-name DDL race must fail instead of silently
 * adopting and stamping a foreign definition. Rejecting every other shape before
 * the first query keeps this opt-in from becoming a generic escape hatch around
 * the transactional migration runner.
 */
function parseConcurrentIndexStatement(
  migration: Migration,
  statement: string,
): ConcurrentIndexStatement {
  const sqlLines: string[] = [];
  let sqlStarted = false;
  for (const line of statement.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!sqlStarted && (trimmed.length === 0 || trimmed.startsWith("--"))) {
      continue;
    }
    sqlStarted = true;
    sqlLines.push(line);
  }
  const sql = sqlLines.join("\n").trim();
  if (sql.includes("/*") || sql.includes("*/") || sql.includes("--")) {
    throw new Error(
      `Nontransactional migration ${migration.entry.tag} contains unsupported SQL comments`,
    );
  }
  const sqlWithoutTerminator = sql.endsWith(";")
    ? sql.slice(0, -1).trimEnd()
    : sql;
  if (sqlWithoutTerminator.includes(";")) {
    throw new Error(
      `Nontransactional migration ${migration.entry.tag} must contain exactly one statement per breakpoint`,
    );
  }
  const match =
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY(?:\s+IF\s+NOT\s+EXISTS)?\s+"([a-z_][a-z0-9_]*)"\s+ON\s+"([a-z_][a-z0-9_]*)"(\s+[\s\S]+)$/i.exec(
      sqlWithoutTerminator,
    );
  if (!match?.[2] || !match[3] || !match[4]) {
    throw new Error(
      `Nontransactional migration ${migration.entry.tag} permits only CREATE INDEX CONCURRENTLY statements`,
    );
  }
  if (
    match[2] !== match[2].toLowerCase() ||
    match[3] !== match[3].toLowerCase()
  ) {
    throw new Error(
      `Nontransactional migration ${migration.entry.tag} requires lowercase quoted index and table identifiers`,
    );
  }
  if (Buffer.byteLength(match[2], "utf8") > 63) {
    throw new Error(
      `Nontransactional migration ${migration.entry.tag} index identifier exceeds PostgreSQL's 63-byte limit`,
    );
  }
  if (Buffer.byteLength(match[3], "utf8") > 63) {
    throw new Error(
      `Nontransactional migration ${migration.entry.tag} table identifier exceeds PostgreSQL's 63-byte limit`,
    );
  }
  return {
    definitionTail: match[4],
    indexName: match[2],
    isUnique: match[1] !== undefined,
    statement: `CREATE ${match[1] ?? ""}INDEX CONCURRENTLY "${match[2]}" ON "${match[3]}"${match[4]}`,
    tableName: match[3],
  };
}

function planMigrationExecution(migration: Migration): MigrationExecutionPlan {
  const directiveLines = migration.statements.flatMap((statement) =>
    statement
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line === NONTRANSACTIONAL_CONCURRENT_INDEX_DIRECTIVE),
  );
  const containsConcurrentIndex = migration.statements.some((statement) =>
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(
      statementWithoutFullLineCommentsForDetection(statement),
    ),
  );

  if (directiveLines.length === 0) {
    if (containsConcurrentIndex) {
      throw new Error(
        `Migration ${migration.entry.tag} contains CREATE INDEX CONCURRENTLY without the required nontransactional directive`,
      );
    }
    return { mode: "transactional" };
  }
  const firstSourceLine = migration.statements[0]
    ?.split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (
    directiveLines.length !== 1 ||
    firstSourceLine !== NONTRANSACTIONAL_CONCURRENT_INDEX_DIRECTIVE
  ) {
    throw new Error(
      `Migration ${migration.entry.tag} must declare the nontransactional directive exactly once as its first line`,
    );
  }

  return {
    mode: "nontransactional-concurrent-indexes",
    statements: migration.statements.map((statement) =>
      parseConcurrentIndexStatement(migration, statement),
    ),
  };
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
    let transactionMayBeActive = false;
    let advisoryLockMayBeHeld = false;
    try {
      // Keep the advisory-lock budget transaction-local. PostgreSQL restores the
      // exact effective session/role/database value on COMMIT or ROLLBACK, so
      // the dedicated migration session never has to approximate it with `0`.
      transactionMayBeActive = true;
      await client.query("BEGIN");
      await client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${options.timeoutMs}ms`,
      ]);
      // Mark submission before awaiting the response. A client can lose the
      // response after PostgreSQL acquired this session-level lock; the failure
      // path must then attempt an unlock before considering a retry.
      advisoryLockMayBeHeld = true;
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        MIGRATION_ADVISORY_LOCK_KEY,
      ]);
      await client.query("COMMIT");
      transactionMayBeActive = false;
      console.log(`[db:migrate] acquired migration lock on attempt ${attempt}`);
      return;
    } catch (error) {
      await runCleanupSteps(
        [
          {
            label: "migration advisory-lock transaction rollback",
            run: async () => {
              if (transactionMayBeActive) await client.query("ROLLBACK");
            },
          },
          {
            label: "ambiguous migration advisory-lock release",
            run: async () => {
              if (!advisoryLockMayBeHeld) return;
              const result = await client.query<{ unlocked: boolean }>(
                "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
                [MIGRATION_ADVISORY_LOCK_KEY],
              );
              if (typeof result.rows[0]?.unlocked !== "boolean") {
                throw new Error(
                  "Migration advisory-lock cleanup returned an invalid result",
                );
              }
            },
          },
        ],
        reportMigrationCleanupFailure,
        { error },
      );
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

async function readConcurrentIndexState(
  client: MigrationClient,
  source: Pick<ConcurrentIndexStatement, "indexName" | "tableName">,
): Promise<ConcurrentIndexState> {
  const result = await client.query<ConcurrentIndexState>(
    `SELECT target_relation.oid::text AS target_oid,
      target_relation.relkind AS target_relation_kind,
      target_namespace.nspname AS target_namespace,
      index_relation.oid::text AS index_oid,
      index_namespace.nspname AS index_namespace,
      index_relation.relkind AS relation_kind,
      indexed_table.oid::text AS indexed_table_oid,
      indexed_table.relname AS table_name,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint AS owning_constraint
        WHERE owning_constraint.conindid = index_relation.oid
      ) AS constraint_owned,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_catalog.pg_class'::regclass
          AND extension_dependency.objid = index_relation.oid
          AND extension_dependency.objsubid = 0
          AND extension_dependency.deptype = 'e'
      ) AS extension_owned,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_inherits AS partition_attachment
        WHERE partition_attachment.inhrelid = index_relation.oid
      ) AS partition_attached,
      index_metadata.indisprimary AS primary,
      index_metadata.indisexclusion AS exclusion,
      index_metadata.indisready AS ready,
      index_metadata.indisvalid AS valid,
      index_metadata.indislive AS live,
      pg_catalog.obj_description(index_relation.oid, 'pg_class') AS migration_marker
    FROM (SELECT to_regclass($1) AS target_oid) AS target_resolution
    LEFT JOIN pg_catalog.pg_class AS target_relation
      ON target_relation.oid = target_resolution.target_oid
    LEFT JOIN pg_catalog.pg_namespace AS target_namespace
      ON target_namespace.oid = target_relation.relnamespace
    LEFT JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.relnamespace = target_relation.relnamespace
      AND index_relation.relname = $2
    LEFT JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    LEFT JOIN pg_catalog.pg_index AS index_metadata
      ON index_metadata.indexrelid = index_relation.oid
    LEFT JOIN pg_catalog.pg_class AS indexed_table
      ON indexed_table.oid = index_metadata.indrelid`,
    [source.tableName, source.indexName],
  );
  const state = result.rows[0];
  if (!state) {
    throw new Error(
      `Concurrent index catalog lookup returned no row for ${source.indexName}`,
    );
  }
  if (
    state.target_oid === null ||
    !["p", "r"].includes(state.target_relation_kind ?? "") ||
    typeof state.target_namespace !== "string"
  ) {
    throw new Error(
      `Concurrent index target ${source.tableName} is missing or is not an ordinary or partitioned table`,
    );
  }
  if (state.relation_kind === null) return state;
  if (
    state.relation_kind !== "i" ||
    typeof state.index_namespace !== "string" ||
    typeof state.index_oid !== "string" ||
    typeof state.indexed_table_oid !== "string" ||
    typeof state.table_name !== "string" ||
    typeof state.constraint_owned !== "boolean" ||
    typeof state.extension_owned !== "boolean" ||
    typeof state.partition_attached !== "boolean" ||
    typeof state.primary !== "boolean" ||
    typeof state.exclusion !== "boolean" ||
    typeof state.ready !== "boolean" ||
    typeof state.valid !== "boolean" ||
    typeof state.live !== "boolean" ||
    (state.migration_marker !== null &&
      typeof state.migration_marker !== "string")
  ) {
    throw new Error(
      `Concurrent index ${source.indexName} collides with a non-index relation or malformed catalog entry`,
    );
  }
  return state;
}

async function readConcurrentIndexDefinition(
  client: MigrationClient,
  indexOid: string,
): Promise<string> {
  const result = await client.query<ConcurrentIndexDefinition>(
    `SELECT pg_catalog.jsonb_build_object(
      'access_method', access_method.amname,
      'collations', index_metadata.indcollation::text,
      'elements', (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.pg_get_indexdef(index_metadata.indexrelid, ordinal, false)
          ORDER BY ordinal
        )
        FROM pg_catalog.generate_series(1, index_metadata.indnatts) AS ordinal
      ),
      'expressions', pg_catalog.pg_get_expr(
        index_metadata.indexprs,
        index_metadata.indrelid,
        false
      ),
      'key_count', index_metadata.indnkeyatts,
      'nulls_not_distinct', index_metadata.indnullsnotdistinct,
      'opclasses', index_metadata.indclass::text,
      'options', COALESCE((
        SELECT pg_catalog.jsonb_agg(option ORDER BY option)
        FROM pg_catalog.unnest(index_relation.reloptions) AS option
      ), '[]'::jsonb),
      'ordering', index_metadata.indoption::text,
      'predicate', pg_catalog.pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid,
        false
      ),
      'tablespace', tablespace.spcname,
      'total_count', index_metadata.indnatts,
      'unique', index_metadata.indisunique
    )::text AS canonical_definition
    FROM pg_catalog.pg_index AS index_metadata
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    LEFT JOIN pg_catalog.pg_tablespace AS tablespace
      ON tablespace.oid = NULLIF(index_relation.reltablespace, 0)
    WHERE index_metadata.indexrelid = $1::oid`,
    [indexOid],
  );
  const definition = result.rows[0]?.canonical_definition;
  if (typeof definition !== "string" || result.rows.length !== 1) {
    throw new Error(
      "Concurrent index PostgreSQL-canonical definition lookup returned an invalid result",
    );
  }
  return definition;
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function readExpectedConcurrentIndexDefinition(
  client: MigrationClient,
  source: ConcurrentIndexStatement,
  probeOrdinal: number,
): Promise<string> {
  const probeTableName = `__eliza_migration_index_shape_t_${probeOrdinal}`;
  const probeIndexName = `__eliza_migration_index_shape_i_${probeOrdinal}`;
  // A permanent index without an explicit TABLESPACE uses default_tablespace,
  // while a probe on a TEMP table ordinarily uses temp_tablespaces. Align the
  // transaction-local probe setting so tablespace remains an exact comparison.
  await client.query(
    "SELECT pg_catalog.set_config('temp_tablespaces', pg_catalog.current_setting('default_tablespace'), true)",
  );
  await client.query(
    `CREATE TEMP TABLE ${sqlIdentifier(probeTableName)} (LIKE ${sqlIdentifier(source.tableName)} INCLUDING ALL EXCLUDING INDEXES) ON COMMIT DROP`,
  );
  await client.query(
    `CREATE ${source.isUnique ? "UNIQUE " : ""}INDEX ${sqlIdentifier(probeIndexName)} ON ${sqlIdentifier(probeTableName)}${source.definitionTail}`,
  );
  const probeOid = await client.query<{ index_oid: string | null }>(
    "SELECT to_regclass($1)::oid::text AS index_oid",
    [`pg_temp.${probeIndexName}`],
  );
  const indexOid = probeOid.rows[0]?.index_oid;
  if (typeof indexOid !== "string" || probeOid.rows.length !== 1) {
    throw new Error(
      `Concurrent index ${source.indexName} canonical probe was not created`,
    );
  }
  return readConcurrentIndexDefinition(client, indexOid);
}

function assertConcurrentIndexIdentity(
  state: ConcurrentIndexState,
  source: ConcurrentIndexStatement,
): asserts state is ConcurrentIndexState & {
  index_namespace: string;
  index_oid: string;
  indexed_table_oid: string;
  target_namespace: string;
  target_oid: string;
} {
  if (
    state.relation_kind === null ||
    state.index_namespace !== state.target_namespace ||
    state.indexed_table_oid !== state.target_oid ||
    state.table_name !== source.tableName
  ) {
    throw new Error(
      `Concurrent index ${source.indexName} does not belong to the exact target namespace and table ${source.tableName}`,
    );
  }
}

function assertConcurrentIndexIsStandalone(
  state: ConcurrentIndexState,
  source: ConcurrentIndexStatement,
): void {
  if (
    state.constraint_owned === true ||
    state.extension_owned === true ||
    state.partition_attached === true ||
    state.primary === true ||
    state.exclusion === true
  ) {
    throw new Error(
      `Concurrent index ${source.indexName} is constraint-owned, extension-owned, partition-attached, primary, or exclusion-backed and cannot be reconciled by this migration mode`,
    );
  }
}

async function assertConcurrentIndexDefinition(
  client: MigrationClient,
  state: ConcurrentIndexState,
  source: ConcurrentIndexStatement,
  expectedDefinition: string,
): Promise<void> {
  assertConcurrentIndexIdentity(state, source);
  const actualDefinition = await readConcurrentIndexDefinition(
    client,
    state.index_oid,
  );
  if (actualDefinition !== expectedDefinition) {
    throw new Error(
      `Concurrent index ${source.indexName} does not match its PostgreSQL-canonical migration definition`,
    );
  }
}

function concurrentIndexMigrationMarker(
  migration: Migration,
  source: ConcurrentIndexStatement,
): string {
  return `eliza:migration-index:v1:${migration.entry.when}:${migration.hash}:${source.indexName}`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function concurrentIndexIsComplete(state: ConcurrentIndexState): boolean {
  return state.ready === true && state.valid === true && state.live === true;
}

async function runConcurrentIndexFence<T>(
  client: MigrationClient,
  label: string,
  statements: readonly ConcurrentIndexStatement[],
  options: LockRetryOptions,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  let transactionActive = true;
  try {
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      `${options.timeoutMs}ms`,
    ]);
    const tableNames = [
      ...new Set(statements.map(({ tableName }) => tableName)),
    ].sort();
    for (const tableName of tableNames) {
      await client.query(
        `LOCK TABLE ${sqlIdentifier(tableName)} IN SHARE UPDATE EXCLUSIVE MODE`,
      );
    }
    const result = await operation();
    await client.query("COMMIT");
    transactionActive = false;
    return result;
  } catch (error) {
    await runCleanupSteps(
      [
        {
          label: `concurrent-index fence rollback for ${label}`,
          run: async () => {
            if (transactionActive) await client.query("ROLLBACK");
          },
        },
      ],
      reportMigrationCleanupFailure,
      { error },
    );
    throw error;
  }
}

async function reconcileConcurrentIndex(
  client: MigrationClient,
  migration: Migration,
  source: ConcurrentIndexStatement,
  options: LockRetryOptions,
  onDdlStateChange: (active: boolean) => void,
): Promise<void> {
  const expectedMarker = concurrentIndexMigrationMarker(migration, source);
  const reconciliation = await runConcurrentIndexFence(
    client,
    `${migration.entry.tag}:${source.indexName}`,
    [source],
    options,
    async () => {
      const state = await readConcurrentIndexState(client, source);
      if (state.relation_kind === null) return { action: "create" } as const;

      assertConcurrentIndexIdentity(state, source);
      assertConcurrentIndexIsStandalone(state, source);
      const expectedDefinition = await readExpectedConcurrentIndexDefinition(
        client,
        source,
        0,
      );
      await assertConcurrentIndexDefinition(
        client,
        state,
        source,
        expectedDefinition,
      );
      if (
        state.migration_marker !== null &&
        state.migration_marker !== expectedMarker
      ) {
        throw new Error(
          `Concurrent index ${source.indexName} carries a different migration identity`,
        );
      }
      if (concurrentIndexIsComplete(state)) {
        return { action: "reuse" } as const;
      }
      throw new Error(
        `Concurrent index ${source.indexName} is incomplete; refusing automatic repair on a live table`,
      );
    },
  );

  if (reconciliation.action === "reuse") {
    console.log(
      `[db:migrate] concurrent index ${source.indexName} has the exact canonical definition and is already complete`,
    );
    return;
  }
  const setting = await client.query<LockTimeoutSetting>(
    "SELECT pg_catalog.current_setting('lock_timeout') AS lock_timeout",
  );
  const previousLockTimeout = setting.rows[0]?.lock_timeout;
  if (
    typeof previousLockTimeout !== "string" ||
    previousLockTimeout.length === 0 ||
    setting.rows.length !== 1
  ) {
    throw new Error(
      `Concurrent index ${source.indexName} could not read the session lock_timeout`,
    );
  }

  // CREATE INDEX CONCURRENTLY can legitimately wait longer than the bounded
  // metadata fences above. Disable any database/role/session default only for
  // the DDL statement, then restore the caller's exact setting even when
  // PostgreSQL leaves an incomplete index after interruption.
  await client.query("SELECT set_config('lock_timeout', $1, false)", ["0"]);
  await runWithCleanup(
    async () => {
      // Treat submission as the point of no automatic retry. If PostgreSQL
      // returns 55P03 after this call begins, a concurrent build may already
      // have left catalog state that must be re-inspected on an explicit rerun.
      onDdlStateChange(true);
      await client.query(source.statement);
      onDdlStateChange(false);
    },
    [
      {
        label: `session lock-timeout restore for ${migration.entry.tag}:${source.indexName}`,
        run: async () => {
          await client.query("SELECT set_config('lock_timeout', $1, false)", [
            previousLockTimeout,
          ]);
        },
      },
    ],
    reportMigrationCleanupFailure,
  );
}

async function publishConcurrentIndexMigration(
  client: MigrationClient,
  migration: Migration,
  statements: readonly ConcurrentIndexStatement[],
  options: LockRetryOptions,
): Promise<void> {
  await runConcurrentIndexFence(
    client,
    `${migration.entry.tag}:publication`,
    statements,
    options,
    async () => {
      for (const [index, source] of statements.entries()) {
        const state = await readConcurrentIndexState(client, source);
        if (state.relation_kind === null) {
          throw new Error(
            `Concurrent index ${source.indexName} disappeared before atomic publication`,
          );
        }
        assertConcurrentIndexIsStandalone(state, source);
        const expectedDefinition = await readExpectedConcurrentIndexDefinition(
          client,
          source,
          index,
        );
        await assertConcurrentIndexDefinition(
          client,
          state,
          source,
          expectedDefinition,
        );
        if (!concurrentIndexIsComplete(state)) {
          throw new Error(
            `Concurrent index ${source.indexName} is incomplete before atomic publication`,
          );
        }
        const marker = concurrentIndexMigrationMarker(migration, source);
        if (
          state.migration_marker !== null &&
          state.migration_marker !== marker
        ) {
          throw new Error(
            `Concurrent index ${source.indexName} carries a different migration identity`,
          );
        }
        assertConcurrentIndexIdentity(state, source);
        await client.query(
          `COMMENT ON INDEX ${sqlIdentifier(state.target_namespace)}.${sqlIdentifier(source.indexName)} IS ${sqlStringLiteral(marker)}`,
        );
        // COMMENT is transactional and keeps a lock on this exact index until
        // commit. Re-resolve by name and repeat every identity/shape check only
        // after that lock is held: table SHARE UPDATE EXCLUSIVE alone does not
        // conflict with every ALTER INDEX variant.
        const completed = await readConcurrentIndexState(client, source);
        assertConcurrentIndexIsStandalone(completed, source);
        await assertConcurrentIndexDefinition(
          client,
          completed,
          source,
          expectedDefinition,
        );
        if (
          completed.index_oid !== state.index_oid ||
          completed.migration_marker !== marker ||
          !concurrentIndexIsComplete(completed)
        ) {
          throw new Error(
            `Concurrent index ${source.indexName} changed during atomic publication`,
          );
        }
      }
      await client.query(
        `INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (hash, created_at) VALUES ($1, $2)`,
        [migration.hash, migration.entry.when],
      );
    },
  );
}

/**
 * Applies a replay-safe concurrent-index migration without wrapping its DDL in
 * a transaction. The advisory migration lock remains held by `runMigrations`.
 * Every complete remnant is adopted only after PostgreSQL itself canonicalizes
 * and matches its full definition. Incomplete remnants fail closed without DDL:
 * automatic DROP would block the live table, while concurrent DROP cannot bind
 * to the verified OID and concurrent REINDEX can leave helper remnants after an
 * interruption. A short, DML-compatible table fence then revalidates every
 * relation and commits all final markers with the ledger atomically, so a
 * process loss cannot publish either half alone.
 */
async function applyConcurrentIndexMigration(
  client: MigrationClient,
  migration: Migration,
  statements: readonly ConcurrentIndexStatement[],
  options: LockRetryOptions,
): Promise<void> {
  const { entry } = migration;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    let ddlInFlight = false;
    try {
      console.log(
        `[db:migrate] applying ${entry.tag} (${statements.length} concurrent indexes, attempt ${attempt}/${options.maxAttempts})`,
      );

      for (const [index, source] of statements.entries()) {
        try {
          await reconcileConcurrentIndex(
            client,
            migration,
            source,
            options,
            (active) => {
              ddlInFlight = active;
            },
          );
        } catch (error) {
          console.error(
            `[db:migrate] failed ${entry.tag} concurrent index ${index + 1}/${statements.length}`,
          );
          console.error(
            `[db:migrate] sql: ${summarizeStatement(source.statement)}`,
          );
          console.error(`[db:migrate] error: ${formatDatabaseError(error)}`);
          throw error;
        }
      }
      await publishConcurrentIndexMigration(
        client,
        migration,
        statements,
        options,
      );
      return;
    } catch (error) {
      if (!isLockTimeout(error) || ddlInFlight) throw error;
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

/** Applies one or more journal entries in one transaction and ledger commit. */
async function applyMigrationBatch(
  client: MigrationClient,
  migrations: readonly Migration[],
  options: LockRetryOptions,
): Promise<void> {
  if (migrations.length === 0) {
    throw new Error("Migration batch must contain at least one journal entry");
  }
  for (const migration of migrations) {
    if (planMigrationExecution(migration).mode !== "transactional") {
      throw new Error(
        `Nontransactional migration ${migration.entry.tag} cannot be included in an atomic migration batch`,
      );
    }
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
  const plan = planMigrationExecution(migration);
  if (plan.mode === "nontransactional-concurrent-indexes") {
    await applyConcurrentIndexMigration(
      client,
      migration,
      plan.statements,
      options,
    );
    return;
  }
  await applyMigrationBatch(client, [migration], options);
}

async function createPGliteClient(url: string): Promise<MigrationClient> {
  const stripped = url.slice("pglite://".length);
  const dataDir = !stripped || stripped === "memory" ? undefined : stripped;
  const { PGlite } = await import("@electric-sql/pglite");
  const { btree_gist } = await import(
    "@electric-sql/pglite/contrib/btree_gist"
  );
  const { vector } = await import("@electric-sql/pglite/vector");
  const db = await PGlite.create({
    dataDir,
    extensions: { btree_gist, vector },
  });

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
