/**
 * Pluggable database client for Steward.
 *
 * Selects a driver based on the `DATABASE_DRIVER` env var:
 *   - "postgres-js"  (default)  — long-lived TCP pool via the `postgres` package.
 *                                  Used by Bun/Node entry points.
 *   - "neon-http"                — HTTP-only fetch driver via @neondatabase/serverless.
 *                                  Used by Cloudflare Workers (no TCP, no pools).
 *   - PGLite                     — in-process WASM, set via setPGLiteOverride()
 *                                  from the embedded/desktop entry point.
 *
 * Per-request usage on Workers
 * ────────────────────────────
 * Workers cannot share a TCP pool across isolates. For Workers code, prefer
 * `createDbForRequest(env)` and stash the result on `c.var.db` via middleware.
 * The neon-http driver is fetch-based and safe to instantiate per request.
 *
 * Singleton usage (Bun/Node)
 * ──────────────────────────
 * `getDb()` keeps a single Drizzle instance per process.
 *   - postgres-js: pool of 10 connections, prepare:false
 *   - neon-http  : creates one fetch-based client and reuses it
 */

import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PGLiteDb } from "./pglite";

import * as schema from "./schema";
import * as schemaAuth from "./schema-auth";

declare const process: {
  env: Record<string, string | undefined>;
};

export type DatabaseDriver = "postgres-js" | "neon-http";

const FULL_SCHEMA = { ...schema, ...schemaAuth };

export function getDatabaseDriver(): DatabaseDriver {
  const raw = process.env.DATABASE_DRIVER?.trim().toLowerCase();
  if (raw === "neon-http") return "neon-http";
  return "postgres-js";
}

export function getDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return connectionString;
}

export function createPostgresClient(connectionString = getDatabaseUrl()) {
  return postgres(connectionString, {
    max: 10,
    prepare: false,
  });
}

// ─── postgres-js (Bun/Node) ───────────────────────────────────────────────────

export function createDb(connectionString = getDatabaseUrl()) {
  const client = createPostgresClient(connectionString);
  const db = drizzlePostgres(client, { schema: FULL_SCHEMA });

  return { client, db };
}

// ─── neon-http (Cloudflare Workers) ───────────────────────────────────────────

/**
 * Create a Drizzle instance backed by Neon's HTTP fetch driver.
 *
 * Suitable for stateless runtimes (Cloudflare Workers, edge functions).
 * Each call returns a fresh client; for per-request use this is intentional —
 * the underlying transport is HTTP, so there is no TCP connection to reuse.
 */
export function createNeonHttpDb(connectionString = getDatabaseUrl()) {
  // Lazy-require so Bun/Node entry points don't pull @neondatabase/serverless
  // into their bundle when the postgres-js driver is in use.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import shape
  const { neon } = require("@neondatabase/serverless") as { neon: (url: string) => any };
  const client = neon(connectionString);
  const db = drizzleNeon(client, { schema: FULL_SCHEMA });
  return { client, db };
}

/**
 * Build a Drizzle instance from Worker `env` bindings. Intended to be wired
 * into a per-request Hono middleware:
 *
 *   app.use("*", async (c, next) => {
 *     c.set("db", createDbForRequest(c.env));
 *     await next();
 *   });
 *
 * @param env  An object with a DATABASE_URL string field. Workers pass in the
 *             whole `env` binding object.
 */
export function createDbForRequest(env: { DATABASE_URL?: string }) {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL binding is required for createDbForRequest()");
  return createNeonHttpDb(url).db;
}

// ─── PGLite support ───────────────────────────────────────────────────────────
// When running in embedded/local mode, the PGLite adapter sets these overrides
// so all existing code that calls getDb()/closeDb() works unchanged.

let pgliteOverride:
  | {
      db: ReturnType<typeof createDb>["db"] | PGLiteDb;
      close: () => Promise<void>;
    }
  | undefined;

/**
 * Set PGLite as the backing database. Called by the embedded entry point
 * BEFORE any route code runs.
 */
export function setPGLiteOverride(
  db: ReturnType<typeof createDb>["db"] | PGLiteDb,
  close: () => Promise<void>,
) {
  pgliteOverride = { db, close };
}

// ─── Global singleton ─────────────────────────────────────────────────────────

type GlobalDbHandle =
  | { driver: "postgres-js"; client: ReturnType<typeof postgres>; db: ReturnType<typeof drizzlePostgres> }
  | { driver: "neon-http"; client: ReturnType<typeof createNeonHttpDb>["client"]; db: ReturnType<typeof createNeonHttpDb>["db"] };

let globalDb: GlobalDbHandle | undefined;

function buildGlobalDb(): GlobalDbHandle {
  const driver = getDatabaseDriver();
  if (driver === "neon-http") {
    const { client, db } = createNeonHttpDb();
    return { driver: "neon-http", client, db };
  }
  const { client, db } = createDb();
  return { driver: "postgres-js", client, db };
}

export function getDb() {
  if (pgliteOverride) return pgliteOverride.db as ReturnType<typeof createDb>["db"];
  globalDb ??= buildGlobalDb();
  // Both postgres-js and neon-http drivers expose the same Drizzle surface
  // for our schema; we type the public return as the postgres-js variant so
  // callers don't have to branch on driver type at every call site.
  return globalDb.db as unknown as ReturnType<typeof createDb>["db"];
}

/**
 * Return the raw SQL tagged-template client.
 *
 * Both `postgres` (postgres-js) and `neon` (neon-http) expose a tagged-template
 * call signature that returns the result rows directly. The two clients differ
 * in their full surface (e.g. `client.end()`, transactions), so callers that
 * need driver-specific features should branch on `getDatabaseDriver()`.
 *
 * `auth_kv_store` (packages/auth/src/store-backends.ts) only uses the tagged
 * template, which is portable across both.
 */
export function getSql() {
  if (pgliteOverride) {
    throw new Error("getSql() is not available in PGLite mode — use getDb() instead");
  }
  globalDb ??= buildGlobalDb();
  return globalDb.client;
}

export async function closeDb() {
  if (pgliteOverride) {
    await pgliteOverride.close();
    pgliteOverride = undefined;
    return;
  }

  if (!globalDb) {
    return;
  }

  if (globalDb.driver === "postgres-js") {
    await globalDb.client.end();
  }
  // neon-http has no persistent connection to close.

  globalDb = undefined;
}

export type Database = ReturnType<typeof getDb>;
