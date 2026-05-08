/**
 * Drizzle Neon HTTP client factory for Cloudflare Workers.
 *
 * Each request gets its own logical client. The Neon HTTP driver is fetch-based and
 * stateless. Schema lives in this package — read-only from route handlers.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { Pool as PgPool, type PoolConfig } from "pg";

import { disableLocalPreparedStatements } from "./local-pg-query";
import * as schema from "./schemas";

export type WorkerNeonDb = NeonHttpDatabase<typeof schema>;
type WorkerDb = WorkerNeonDb | NodePgDatabase<typeof schema>;

/** Minimal env slice required by `getWorkerNeonDb` (matches Cloud Worker `Bindings`). */
export interface WorkerNeonEnvSlice {
  DATABASE_URL: string;
  DATABASE_DIALECT?: string;
  DATABASE_ENGINE?: string;
  LOCAL_PG_POOL_MAX?: string;
}

const neonCache = new WeakMap<object, WorkerDb>();
const requestCache = new WeakMap<object, WorkerDb>();

function assertPostgresDialect(env: WorkerNeonEnvSlice): void {
  const raw = String(env.DATABASE_DIALECT ?? env.DATABASE_ENGINE ?? "postgresql")
    .trim()
    .toLowerCase();
  if (raw === "sqlite" || raw === "d1") {
    throw new Error(
      "DATABASE_ENGINE=d1/DATABASE_DIALECT=sqlite is not supported by this Postgres Drizzle client yet.",
    );
  }
}

function isNeonDatabase(url: string): boolean {
  return url.includes("neon.tech") || url.includes("neon.database");
}

function isLocalTcpPostgresUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createPgPool(env: WorkerNeonEnvSlice): PgPool {
  const url = env.DATABASE_URL;
  const options: PoolConfig = {
    connectionString: url,
    max: parsePositiveInteger(env.LOCAL_PG_POOL_MAX, 4),
    // 0 disables pg-pool's idle timer; the timer's `.unref()` call crashes
    // on the workerd runtime ("Uncaught TypeError: o.unref is not a function").
    // Connections sit idle until process exit, which is fine for short-lived
    // wrangler dev / e2e runs.
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  };
  const pool = new PgPool(options);
  if (isLocalTcpPostgresUrl(url)) {
    disableLocalPreparedStatements(pool, { simpleQueryMode: true });
  }
  return pool;
}

function createWorkerDb(env: WorkerNeonEnvSlice): WorkerDb {
  const url = env.DATABASE_URL;
  if (isNeonDatabase(url)) {
    return drizzle(neon(url), { schema });
  }

  const pool = createPgPool(env);
  return drizzleNode(pool, { schema });
}

/**
 * Drizzle DB client for the current Worker request.
 *
 * Neon HTTP clients are cached per Worker env because they are fetch-based.
 * Vanilla Postgres pools are cached only on the Hono context so Wrangler/workerd
 * never reuses a pool promise across request contexts.
 */
export function getWorkerNeonDb(c: { env: WorkerNeonEnvSlice }): WorkerNeonDb {
  const env = c.env;
  assertPostgresDialect(env);
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not configured");
  }

  if (isNeonDatabase(url)) {
    const cached = neonCache.get(env as object);
    if (cached) return cached as unknown as WorkerNeonDb;
    const db = createWorkerDb(env);
    neonCache.set(env as object, db);
    return db as unknown as WorkerNeonDb;
  }

  const requestKey = c as object;
  const cached = requestCache.get(requestKey);
  if (cached) return cached as unknown as WorkerNeonDb;
  const db = createWorkerDb(env);
  requestCache.set(requestKey, db);
  return db as unknown as WorkerNeonDb;
}

export { schema };
