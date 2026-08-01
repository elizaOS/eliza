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
import { redactSensitiveText } from "@elizaos/core";
import pg from "pg";

const { Client } = pg;
const REQUIRED_MIGRATIONS = [
  {
    createdAt: 1_785_384_000_000,
    file: "0185_job_execution_interruptions.sql",
  },
  {
    createdAt: 1_785_614_400_001,
    file: "0188_job_execution_interruptions_catalog_guard.sql",
  },
] as const;
const DEFAULT_MAX_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 2_000;

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

interface QueryClient {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
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

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return redactSensitiveText(String(error));
  const code = (error as Error & { code?: unknown }).code;
  const identity =
    typeof code === "string" ? `${error.name}[${code}]` : error.name;
  return `${identity}: ${redactSensitiveText(error.message)}`;
}

async function expectedMigrationHash(file: string): Promise<string> {
  const sql = await readFile(migrationPath(file), "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

/** Verifies the column and journal row through PostgreSQL's real catalogs. */
export async function verifyJobExecutionInterruptionsCatalog(
  client: QueryClient,
): Promise<void> {
  const catalog = await client.query<CatalogRow>(`
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
    column?.data_type !== "integer" ||
    column.attnotnull !== true ||
    column.default_expression !== "0" ||
    column.attgenerated !== ""
  ) {
    const found = column
      ? `type=${column.data_type}, not_null=${column.attnotnull}, default=${column.default_expression ?? "none"}, generated=${column.attgenerated || "no"}`
      : "missing";
    throw new Error(
      `jobs.execution_interruptions catalog mismatch: expected writable integer NOT NULL DEFAULT 0, found ${found}`,
    );
  }

  const journal = await client.query<JournalRow>(
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
      (row) => Number(row.created_at) === migration.createdAt,
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

async function runPreflight(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for schema preflight");

  const maxAttempts = readPositiveInteger(
    "JOB_INTERRUPTION_PREFLIGHT_MAX_ATTEMPTS",
    DEFAULT_MAX_ATTEMPTS,
  );
  const delayMs = readPositiveInteger(
    "JOB_INTERRUPTION_PREFLIGHT_DELAY_MS",
    DEFAULT_DELAY_MS,
  );
  const { url, ssl } = enforceTlsForRemote(databaseUrl);
  const client = new Client({ connectionString: url, ...(ssl ? { ssl } : {}) });
  await client.connect();

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await verifyJobExecutionInterruptionsCatalog(client);
        console.log(
          `[job-interruption-preflight] catalog and journal verified on attempt ${attempt}`,
        );
        return;
      } catch (error) {
        if (attempt === maxAttempts) {
          console.error(
            `[job-interruption-preflight] exhausted ${maxAttempts} attempts: ${safeError(error)}`,
          );
          throw error;
        }
        const jitterMs = Math.floor(Math.random() * Math.min(250, delayMs));
        console.warn(
          `[job-interruption-preflight] attempt ${attempt}/${maxAttempts} failed: ${safeError(error)}; retrying in ${delayMs + jitterMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs + jitterMs));
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  runPreflight().catch((error) => {
    console.error(`[job-interruption-preflight] fatal: ${safeError(error)}`);
    process.exit(1);
  });
}
