/**
 * Verifies the durable job-interruption schema before a provisioning worker
 * starts code that reads it. The check binds deployment to both PostgreSQL's
 * exact catalog shape and the migration file hash, so a journal-only success
 * or an incompatible same-named column fails closed.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { enforceTlsForRemote } from "@elizaos/cloud-shared/db/client";
import { ElizaError, redactSensitiveText } from "@elizaos/core";
import pg, { type ClientConfig } from "pg";
import {
  type CleanupFailure,
  runWithCleanup,
} from "./error-preserving-cleanup";

const { Client } = pg;
const REQUIRED_MIGRATIONS = [
  {
    createdAt: 1_785_384_000_000,
    file: "0185_job_execution_interruptions.sql",
  },
  {
    createdAt: 1_786_392_000_000,
    file: "0193_job_execution_interruptions_catalog_guard.sql",
  },
] as const;
const DEFAULT_MAX_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 2_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 12_000;
/** Leaves 30 seconds inside the eight-minute process fence for startup setup and teardown. */
export const MAX_PREFLIGHT_OPERATION_MS = 450_000;

interface CatalogRow {
  data_type: string;
  attnotnull: boolean;
  default_expression: string | null;
  attgenerated: string;
}

interface JournalRow {
  created_at: string | number | bigint;
  hash: string;
}

/** Database surface required by the catalog verifier. */
export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Connected database surface owned by the standalone preflight process. */
export interface PreflightClient extends QueryClient {
  end(): Promise<void>;
}

/** Bounded retry and PostgreSQL timeout settings for one preflight process. */
export interface PreflightOptions {
  maxAttempts: number;
  delayMs: number;
  connectTimeoutMs: number;
  queryTimeoutMs: number;
  attemptTimeoutMs: number;
}

function isCatalogRow(value: unknown): value is CatalogRow {
  return (
    value !== null &&
    typeof value === "object" &&
    "data_type" in value &&
    typeof value.data_type === "string" &&
    "attnotnull" in value &&
    typeof value.attnotnull === "boolean" &&
    "default_expression" in value &&
    (typeof value.default_expression === "string" ||
      value.default_expression === null) &&
    "attgenerated" in value &&
    typeof value.attgenerated === "string"
  );
}

function isJournalRow(value: unknown): value is JournalRow {
  return (
    value !== null &&
    typeof value === "object" &&
    "created_at" in value &&
    (typeof value.created_at === "string" ||
      typeof value.created_at === "number" ||
      typeof value.created_at === "bigint") &&
    "hash" in value &&
    typeof value.hash === "string"
  );
}

function migrationPath(file: string): string {
  const candidates = [
    path.resolve(
      import.meta.dir,
      "../../../cloud/shared/src/db/migrations",
      file,
    ),
    path.join(process.cwd(), "packages/cloud/shared/src/db/migrations", file),
    path.join(process.cwd(), "src/db/migrations", file),
  ];
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) throw new Error(`Cannot locate ${file}`);
  return selected;
}

function readPositiveInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Computes the hard upper bound before process-level startup teardown. */
export function preflightOperationBudgetMs(options: PreflightOptions): number {
  const maximumJitterMs = Math.max(0, Math.min(250, options.delayMs) - 1);
  return (
    options.connectTimeoutMs +
    options.maxAttempts * options.attemptTimeoutMs +
    Math.max(0, options.maxAttempts - 1) * (options.delayMs + maximumJitterMs)
  );
}

/** Reads and validates the complete bounded preflight configuration. */
export function readPreflightOptions(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PreflightOptions {
  const options = {
    maxAttempts: readPositiveInteger(
      environment,
      "JOB_INTERRUPTION_PREFLIGHT_MAX_ATTEMPTS",
      DEFAULT_MAX_ATTEMPTS,
    ),
    delayMs: readPositiveInteger(
      environment,
      "JOB_INTERRUPTION_PREFLIGHT_DELAY_MS",
      DEFAULT_DELAY_MS,
    ),
    connectTimeoutMs: readPositiveInteger(
      environment,
      "JOB_INTERRUPTION_PREFLIGHT_CONNECT_TIMEOUT_MS",
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    queryTimeoutMs: readPositiveInteger(
      environment,
      "JOB_INTERRUPTION_PREFLIGHT_QUERY_TIMEOUT_MS",
      DEFAULT_QUERY_TIMEOUT_MS,
    ),
    attemptTimeoutMs: readPositiveInteger(
      environment,
      "JOB_INTERRUPTION_PREFLIGHT_ATTEMPT_TIMEOUT_MS",
      DEFAULT_ATTEMPT_TIMEOUT_MS,
    ),
  };
  if (options.attemptTimeoutMs <= options.queryTimeoutMs * 2) {
    throw new ElizaError(
      "JOB_INTERRUPTION_PREFLIGHT_ATTEMPT_TIMEOUT_MS must exceed twice JOB_INTERRUPTION_PREFLIGHT_QUERY_TIMEOUT_MS",
      {
        code: "JOB_INTERRUPTION_PREFLIGHT_INVALID_TIMEOUTS",
        context: {
          attemptTimeoutMs: options.attemptTimeoutMs,
          queryTimeoutMs: options.queryTimeoutMs,
        },
        severity: "fatal",
      },
    );
  }
  const operationBudgetMs = preflightOperationBudgetMs(options);
  if (operationBudgetMs > MAX_PREFLIGHT_OPERATION_MS) {
    throw new ElizaError(
      `Job-interruption preflight worst-case budget ${operationBudgetMs}ms exceeds ${MAX_PREFLIGHT_OPERATION_MS}ms`,
      {
        code: "JOB_INTERRUPTION_PREFLIGHT_BUDGET_EXCEEDED",
        context: { operationBudgetMs, maximumMs: MAX_PREFLIGHT_OPERATION_MS },
        severity: "fatal",
      },
    );
  }
  return options;
}

/** Builds a PostgreSQL client with both socket and server-side query fences. */
export function createPreflightClientConfig(
  databaseUrl: string,
  options: PreflightOptions,
): ClientConfig {
  const { url, ssl } = enforceTlsForRemote(databaseUrl);
  const boundedUrl = new URL(url);
  // node-postgres lets connection-string parameters override explicit client
  // fields, so a stale DSN timeout must not disable the activation fence.
  boundedUrl.searchParams.delete("statement_timeout");
  boundedUrl.searchParams.delete("query_timeout");
  return {
    connectionString: boundedUrl.toString(),
    connectionTimeoutMillis: options.connectTimeoutMs,
    statement_timeout: options.queryTimeoutMs,
    query_timeout: options.queryTimeoutMs,
    application_name: "eliza-job-interruption-preflight",
    ...(ssl ? { ssl } : {}),
  };
}

async function runAttemptWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new ElizaError(
          `Job-interruption catalog verification exceeded ${timeoutMs}ms`,
          {
            code: "JOB_INTERRUPTION_PREFLIGHT_ATTEMPT_TIMEOUT",
            context: { timeoutMs },
            severity: "ephemeral",
          },
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isAttemptWatchdogTimeout(error: unknown): error is ElizaError {
  return (
    error instanceof ElizaError &&
    error.code === "JOB_INTERRUPTION_PREFLIGHT_ATTEMPT_TIMEOUT"
  );
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return redactSensitiveText(String(error));
  const code = (error as Error & { code?: unknown }).code;
  const identity =
    typeof code === "string" ? `${error.name}[${code}]` : error.name;
  return `${identity}: ${redactSensitiveText(error.message)}`;
}

function reportPreflightCleanupFailure(failure: CleanupFailure): void {
  const context = failure.primaryFailure
    ? " while preserving the primary preflight failure"
    : "";
  console.error(
    `[job-interruption-preflight] ${failure.label} failed${context}: ${safeError(failure.cleanupError)}`,
  );
}

async function expectedMigrationHash(file: string): Promise<string> {
  const sql = await readFile(migrationPath(file), "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

/** Verifies the column and journal row through PostgreSQL's real catalogs. */
export async function verifyJobExecutionInterruptionsCatalog(
  client: QueryClient,
): Promise<void> {
  const catalog = await client.query(`
    SELECT
      format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      attribute.attnotnull,
      pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression,
      attribute.attgenerated
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
      AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'jobs'
      AND attribute.attname = 'execution_interruptions'
      AND NOT attribute.attisdropped
  `);
  const column = catalog.rows[0];
  if (
    catalog.rows.length !== 1 ||
    !isCatalogRow(column) ||
    column.data_type !== "integer" ||
    column.attnotnull !== true ||
    column.default_expression !== "0" ||
    column.attgenerated !== ""
  ) {
    const found = isCatalogRow(column)
      ? `type=${column.data_type}, not_null=${column.attnotnull}, default=${column.default_expression ?? "none"}, generated=${column.attgenerated || "no"}`
      : column === undefined
        ? "missing"
        : "invalid catalog row";
    throw new Error(
      `jobs.execution_interruptions catalog mismatch: expected writable integer NOT NULL DEFAULT 0, found ${found}`,
    );
  }

  const journal = await client.query(
    `SELECT created_at, hash
     FROM drizzle.__drizzle_migrations
     WHERE created_at = ANY($1::bigint[])
     ORDER BY id`,
    [REQUIRED_MIGRATIONS.map((migration) => migration.createdAt)],
  );

  if (journal.rows.length !== REQUIRED_MIGRATIONS.length) {
    throw new Error(
      `Job-interruption migration journal mismatch: expected ${REQUIRED_MIGRATIONS.length} rows, found ${journal.rows.length}`,
    );
  }

  for (const migration of REQUIRED_MIGRATIONS) {
    const matching = journal.rows.filter(
      (row): row is JournalRow =>
        isJournalRow(row) && Number(row.created_at) === migration.createdAt,
    );
    const expectedHash = await expectedMigrationHash(migration.file);
    if (matching.length !== 1 || matching[0]?.hash !== expectedHash) {
      const found =
        matching.length === 0
          ? "missing"
          : matching.length === 1
            ? `hash=${matching[0]?.hash}`
            : `${matching.length} rows`;
      throw new Error(
        `Migration ${migration.file} journal mismatch: expected one row with hash=${expectedHash}, found ${found}`,
      );
    }
  }
}

/** Runs bounded catalog verification and always closes its connected client. */
export async function runJobExecutionInterruptionsPreflight(
  client: PreflightClient,
  options: Pick<
    PreflightOptions,
    "maxAttempts" | "delayMs" | "attemptTimeoutMs"
  >,
): Promise<void> {
  await runWithCleanup(
    async () => {
      for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
        try {
          await runAttemptWithTimeout(
            () => verifyJobExecutionInterruptionsCatalog(client),
            options.attemptTimeoutMs,
          );
          console.log(
            `[job-interruption-preflight] catalog and journal verified on attempt ${attempt}`,
          );
          return;
        } catch (error) {
          // A watchdog firing means the pg query/server timeout fences failed
          // to settle the operation. Retrying on that same connection would
          // queue work behind an unresolved query; outer cleanup destroys the
          // active socket before the failure escapes.
          if (isAttemptWatchdogTimeout(error)) {
            console.error(
              `[job-interruption-preflight] attempt ${attempt}/${options.maxAttempts} did not settle before its watchdog: ${safeError(error)}`,
            );
            throw error;
          }
          if (attempt === options.maxAttempts) {
            console.error(
              `[job-interruption-preflight] exhausted ${options.maxAttempts} attempts: ${safeError(error)}`,
            );
            throw error;
          }
          const jitterMs = Math.floor(
            Math.random() * Math.min(250, options.delayMs),
          );
          console.warn(
            `[job-interruption-preflight] attempt ${attempt}/${options.maxAttempts} failed: ${safeError(error)}; retrying in ${options.delayMs + jitterMs}ms`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, options.delayMs + jitterMs),
          );
        }
      }
    },
    [{ label: "database client close", run: () => client.end() }],
    reportPreflightCleanupFailure,
  );
}

async function runPreflight(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for schema preflight");

  const options = readPreflightOptions();
  const client = new Client(createPreflightClientConfig(databaseUrl, options));
  await client.connect();
  await runJobExecutionInterruptionsPreflight(client, options);
}

if (import.meta.main) {
  runPreflight().catch((error) => {
    console.error(`[job-interruption-preflight] fatal: ${safeError(error)}`);
    process.exit(1);
  });
}
