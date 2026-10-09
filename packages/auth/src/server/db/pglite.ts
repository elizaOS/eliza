/**
 * PGLite adapter for Steward — runs Postgres in-process via WASM.
 *
 * Use this for local / desktop mode (Electrobun) where no external
 * PostgreSQL server is available.
 *
 * Environment detection:
 *   - STEWARD_DB_MODE=pglite  → always use PGLite
 *   - No DATABASE_URL set     → fall back to PGLite
 *   - STEWARD_PGLITE_PATH    → persistence directory (default ~/.steward/data)
 *   - STEWARD_PGLITE_MEMORY  → if "true", use in-memory (no persistence)
 */

import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { ElizaError, logger } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "./schema";
import * as schemaAuth from "./schema-auth";

export type PGLiteDb = ReturnType<
  typeof drizzle<typeof schema & typeof schemaAuth>
>;

let globalPGLite: { client: PGlite; db: PGLiteDb } | undefined;

/**
 * Resolve the data directory for PGLite persistence.
 */
export function getDataDir(): string {
  if (process.env.STEWARD_PGLITE_PATH) {
    return resolve(process.env.STEWARD_PGLITE_PATH);
  }
  return join(homedir(), ".steward", "data");
}

/**
 * Determine whether PGLite should be used based on environment variables.
 */
export function shouldUsePGLite(): boolean {
  if (process.env.STEWARD_DB_MODE === "pglite") return true;
  if (!process.env.DATABASE_URL) return true;
  return false;
}

/**
 * Run all SQL migration files from the drizzle/ folder in lexicographic order.
 *
 * This reads every *.sql file (excluding meta/), splits on the Drizzle
 * statement-breakpoint marker, and executes each statement sequentially.
 * The `__steward_migrations` table tracks which files have already been applied
 * so restarts with a persistent data dir don't re-run migrations.
 */
export async function runPGLiteMigrations(
  client: PGlite,
  migrationsFolder = fileURLToPath(new URL("./drizzle", import.meta.url)),
): Promise<void> {
  // Create tracking table
  await client.exec(`
    CREATE TABLE IF NOT EXISTS __steward_migrations (
      tag TEXT PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  // Get already-applied migrations
  const applied = await client.query<{ tag: string }>(
    "SELECT tag FROM __steward_migrations ORDER BY tag",
  );
  const appliedSet = new Set(applied.rows.map((r) => r.tag));

  // Read all SQL files (skip meta/ directory and non-.sql)
  const files = await readdir(migrationsFolder);
  const sqlFiles = files
    .filter((f) => f.endsWith(".sql") && !f.startsWith("."))
    .sort();

  for (const file of sqlFiles) {
    const tag = file.replace(/\.sql$/, "");
    if (appliedSet.has(tag)) continue;

    const filePath = join(migrationsFolder, file);
    const sql = await readFile(filePath, "utf-8");

    // DDL and its ledger entry commit together. A failed statement must never
    // become an applied migration, including duplicate-object/constraint errors.
    try {
      await client.transaction(async (tx) => {
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.exec(statement);
        }
        await tx.query("INSERT INTO __steward_migrations (tag) VALUES ($1)", [
          tag,
        ]);
      });
    } catch (cause) {
      throw new ElizaError("Embedded login migration failed", {
        code: "LOGIN_MIGRATION_FAILED",
        context: { tag },
        cause,
      });
    }

    logger.info(
      { details: [`[pglite] Applied migration: ${file}`] },
      "[Login:pglite] info",
    );
  }
}

/**
 * Create a PGLite-backed Drizzle instance.
 *
 * @param dataDir - directory for persistence, or "memory://" for in-memory
 */
export async function createPGLiteDb(
  dataDir?: string,
): Promise<{ client: PGlite; db: PGLiteDb }> {
  const useMemory =
    dataDir === "memory://" || process.env.STEWARD_PGLITE_MEMORY === "true";

  let connectionTarget: string;
  if (useMemory) {
    connectionTarget = "memory://";
  } else {
    const dir = dataDir ?? getDataDir();
    // SEC-090: the data directory holds encrypted wallet keys, refresh-token
    // hashes, webhook secrets, and audit chains — it must be owner-only.
    // chmod unconditionally so directories created before this guard (or by
    // hand with a permissive umask) are tightened on next start.
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      logger.info(
        { details: [`[pglite] Created data directory: ${dir}`] },
        "[Login:pglite] info",
      );
    }
    const dataDirStat = await lstat(dir);
    if (dataDirStat.isSymbolicLink()) {
      throw new Error(`[pglite] Refusing symbolic-link data directory: ${dir}`);
    }
    if (!dataDirStat.isDirectory()) {
      throw new Error(`[pglite] Data path is not a directory: ${dir}`);
    }
    await chmod(dir, 0o700);
    connectionTarget = dir;
  }

  logger.info(
    { details: [`[pglite] Initializing PGLite at: ${connectionTarget}`] },
    "[Login:pglite] info",
  );
  const client = new PGlite(connectionTarget);

  try {
    await runPGLiteMigrations(client);
    const db = drizzle(client, { schema: { ...schema, ...schemaAuth } });
    return { client, db };
  } catch (cause) {
    // Ownership is not transferred to the caller until initialization succeeds.
    try {
      await client.close();
    } catch (cleanupError) {
      throw new ElizaError("Embedded login initialization and cleanup failed", {
        code: "LOGIN_DATABASE_INITIALIZATION_FAILED",
        cause: new AggregateError([cause, cleanupError]),
      });
    }
    throw cause;
  }
}

/**
 * Get or create the global PGLite DB singleton.
 * Mirrors the getDb() / getSql() pattern from client.ts.
 */
export async function getPGLiteDb(): Promise<PGLiteDb> {
  if (!globalPGLite) {
    globalPGLite = await createPGLiteDb();
  }
  return globalPGLite.db;
}

export async function getPGLiteClient(): Promise<PGlite> {
  if (!globalPGLite) {
    globalPGLite = await createPGLiteDb();
  }
  return globalPGLite.client;
}

export async function closePGLiteDb(): Promise<void> {
  if (!globalPGLite) return;
  await globalPGLite.client.close();
  globalPGLite = undefined;
}
