import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_DIR = path.join(process.cwd(), "packages/db/migrations");
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
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
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

function createdAtValue(migration: AppliedMigration | undefined): number | null {
  if (!migration?.created_at) return null;

  const value = Number(migration.created_at);
  return Number.isFinite(value) ? value : null;
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

async function getLastAppliedMigration(
  client: MigrationClient,
): Promise<AppliedMigration | undefined> {
  const result = await client.query<AppliedMigration>(`
    SELECT id, hash, created_at
    FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
    ORDER BY created_at DESC
    LIMIT 1
  `);

  return result.rows[0];
}

async function applyMigration(client: MigrationClient, migration: Migration): Promise<void> {
  const { entry, statements, hash } = migration;

  console.log(`[db:migrate] applying ${entry.tag} (${statements.length} statements)`);
  await client.query("BEGIN");

  try {
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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function createPGliteClient(url: string): Promise<MigrationClient> {
  const stripped = url.slice("pglite://".length);
  const dataDir = !stripped || stripped === "memory" ? undefined : stripped;
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const db = await PGlite.create({ dataDir, extensions: { vector } });

  return {
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
  const client = new Client({ connectionString: url });
  await client.connect();
  return {
    query: async <T>(text: string, params?: unknown[]) => {
      const result = await client.query<Record<string, unknown>>(text, params);
      return { rows: result.rows as T[] };
    },
    end: () => client.end(),
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  const journal = await readJournal();
  const migrations = await Promise.all(journal.entries.map((entry) => readMigration(entry)));

  const client: MigrationClient = databaseUrl.startsWith("pglite://")
    ? await createPGliteClient(databaseUrl)
    : await createPgClient(databaseUrl);

  try {
    await ensureMigrationsTable(client);

    const lastApplied = await getLastAppliedMigration(client);
    const lastAppliedCreatedAt = createdAtValue(lastApplied);
    console.log(
      `[db:migrate] last applied migration: ${
        lastAppliedCreatedAt === null
          ? "none"
          : `${lastAppliedCreatedAt} (${lastApplied?.hash.slice(0, 12)})`
      }`,
    );

    const pending = migrations.filter(
      (migration) => lastAppliedCreatedAt === null || migration.entry.when > lastAppliedCreatedAt,
    );
    console.log(`[db:migrate] pending migrations: ${pending.length}`);

    for (const migration of pending) {
      await applyMigration(client, migration);
    }

    console.log("[db:migrate] migrations complete");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[db:migrate] fatal: ${formatDatabaseError(error)}`);
  process.exit(1);
});
