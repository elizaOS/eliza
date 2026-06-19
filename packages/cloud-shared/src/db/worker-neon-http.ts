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

export type WorkerNeonDb = NeonHttpDatabase<typeof schema> | NodePgDatabase<typeof schema>;
type WorkerDb = WorkerNeonDb;

/** Minimal env slice required by `getWorkerNeonDb` (matches Cloud Worker `Bindings`). */
export interface WorkerNeonEnvSlice {
  DATABASE_URL: string;
  DATABASE_DIALECT?: string;
  DATABASE_ENGINE?: string;
  LOCAL_PG_POOL_MAX?: string;
  DATABASE_SSL_NO_VERIFY?: string;
  /** Cloudflare Hyperdrive binding (proxies to the origin Postgres). */
  HYPERDRIVE?: { connectionString: string };
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
  // Prefer a Cloudflare Hyperdrive binding when present: workerd can't reliably
  // open a direct node-pg TCP/TLS connection to an external Postgres, so the
  // Worker connects to Hyperdrive's local endpoint and Hyperdrive proxies to the
  // origin (pooling + TLS handled there). Fall back to a direct DATABASE_URL.
  const hyperdriveUrl = env.HYPERDRIVE?.connectionString;
  const url = hyperdriveUrl ?? env.DATABASE_URL;
  const isLocal = isLocalTcpPostgresUrl(url);
  const options: PoolConfig = {
    connectionString: url,
    // 0 disables pg-pool's idle timer; the timer's `.unref()` call crashes
    // on the workerd runtime ("Uncaught TypeError: o.unref is not a function").
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  };
  if (isLocal) {
    // Local PGlite socket bridge is fragile — churning a fresh TCP connection
    // per query causes mid-stream resets, so keep connections and reuse them.
    options.max = parsePositiveInteger(env.LOCAL_PG_POOL_MAX, 8);
  } else {
    // Remote Postgres (Hyperdrive/Railway) on workerd: workerd kills I/O objects
    // across requests, so a reused pg connection terminates mid-query
    // ("Connection terminated unexpectedly"). Use a single connection used once
    // then discarded; Hyperdrive pools the origin side.
    options.max = parsePositiveInteger(env.LOCAL_PG_POOL_MAX, 1);
    options.maxUses = 1;
  }
  if (!isLocal && !hyperdriveUrl) {
    // Direct remote Postgres must use TLS. node-pg's connection-string `sslmode`
    // parsing is unreliable on workerd, so set `ssl` explicitly. A self-signed
    // managed proxy (e.g. Railway) needs verification relaxed when opted in via
    // `DATABASE_SSL_NO_VERIFY=true` or `?sslmode=no-verify` — the connection
    // stays encrypted; only CA verification is skipped. (Hyperdrive terminates
    // origin TLS itself, so its local endpoint needs no `ssl` option here.)
    const skipVerify = env.DATABASE_SSL_NO_VERIFY === "true" || /[?&]sslmode=no-verify\b/.test(url);
    options.ssl = { rejectUnauthorized: !skipVerify };
  }
  const pool = new PgPool(options);
  if (isLocal) {
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
    if (cached) return cached;
    const db = createWorkerDb(env);
    neonCache.set(env as object, db);
    return db;
  }

  const requestKey = c as object;
  const cached = requestCache.get(requestKey);
  if (cached) return cached;
  const db = createWorkerDb(env);
  requestCache.set(requestKey, db);
  return db;
}

export { schema };
