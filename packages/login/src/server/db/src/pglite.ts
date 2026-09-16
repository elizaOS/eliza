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
import { PGlite } from "@electric-sql/pglite";
import { logger } from "@elizaos/logger";
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
async function runPGLiteMigrations(client: PGlite): Promise<void> {
  const migrationsFolder = new URL("../drizzle", import.meta.url).pathname;

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

    // Split on Drizzle's statement-breakpoint marker, or fall back to semicolons
    const statements = sql.includes("--> statement-breakpoint")
      ? sql.split("--> statement-breakpoint")
      : [sql];

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed || trimmed === "--") continue;
      try {
        await client.exec(trimmed);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Ignore "already exists" errors for idempotent migrations
        if (
          message.includes("already exists") ||
          message.includes("duplicate key")
        ) {
          continue;
        }
        throw new Error(
          `Migration ${file} failed: ${message}\nStatement: ${trimmed.slice(0, 200)}`,
        );
      }
    }

    await client.query("INSERT INTO __steward_migrations (tag) VALUES ($1)", [
      tag,
    ]);
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

  // Run migrations
  await runPGLiteMigrations(client);

  const db = drizzle(client, {
    schema: { ...schema, ...schemaAuth },
  });

  return { client, db };
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
