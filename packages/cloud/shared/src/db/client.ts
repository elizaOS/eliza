/**
 * Database Client
 *
 * Environment Variables:
 * - DATABASE_URL: Primary database URL. Use a Railway (or any) Postgres URL for cloud, pglite:// for
 *   embedded local dev, or a vanilla postgresql:// URL.
 *
 * @module db/client
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePGlite, type PgliteDatabase } from "drizzle-orm/pglite";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";
import { Pool as PgPool, type PoolConfig } from "pg";
import { getCloudAwareEnv, getCloudBinding } from "../lib/runtime/cloud-bindings";
import { logger } from "../lib/utils/logger";
import { applyDatabaseUrlFallback } from "./database-url";
import { disableLocalPreparedStatements } from "./local-pg-query";
import * as schema from "./schemas";

// ============================================================================
// Types
// ============================================================================

type SchemaTables = ExtractTablesWithRelations<typeof schema>;

/** Canonical DB type for repositories: avoids union-of-drivers collapsing overloads. */
type Database = NodePgDatabase<typeof schema>;

/** Transaction handle for `writeTransaction` callbacks. */
type DbTransaction = NodePgTransaction<typeof schema, SchemaTables>;

type DatabaseCloser = () => Promise<void> | void;

const databaseClosers = new WeakMap<Database, DatabaseCloser>();

function registerDatabaseCloser(database: Database, closer: DatabaseCloser): Database {
  databaseClosers.set(database, closer);
  return database;
}

/**
 * Get the primary database URL (always required)
 */
function getPrimaryDatabaseUrl(): string {
  const url = applyDatabaseUrlFallback(getCloudAwareEnv());
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Use a Railway (or any) Postgres URL for cloud, a `pglite://<dir>` URL for embedded local dev, or a vanilla `postgresql://` URL.",
    );
  }
  return url;
}

// ============================================================================
// Database Connection Factory
// ============================================================================

function isCloudflareWorkerRuntime(): boolean {
  return typeof globalThis !== "undefined" && "WebSocketPair" in globalThis;
}

/**
 * Parse a `pglite://<dataDir>` URL into the directory path used by
 * `@electric-sql/pglite`. `pglite://memory` (or empty path) maps to in-memory.
 */
function parsePGliteDataDir(url: string): string {
  const stripped = url.slice("pglite://".length);
  if (!stripped || stripped === "memory") {
    return "memory://";
  }
  return stripped;
}

/**
 * The live PGlite instance behind the write connection, captured for
 * `getPgliteClientForTests`. Test-only surface: PGlite-backed suites need the
 * raw client to apply generated DDL (drizzle-kit `pushSchema`) to the SAME
 * in-memory database the exported `db`/`dbRead`/`dbWrite` proxies query.
 * `instanceof` probing from callers cannot do this — the CJS require in
 * `createPGliteClient` and an ESM `import` resolve two distinct copies of the
 * PGlite class.
 */
let pgliteClientForTests: import("@electric-sql/pglite").PGlite | null = null;

/**
 * Build a PGlite instance with the `vector` extension loaded so the
 * cloud schema's pgvector columns (used by trajectories, embeddings, etc.)
 * resolve at migration and query time. Synchronous module require keeps the
 * call site type as `Database`; PGlite is bun/node-only and does not exist
 * on the Workers runtime.
 */
function createPGliteClient(dataDir: string): Database {
  const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  const { vector } =
    require("@electric-sql/pglite/vector") as typeof import("@electric-sql/pglite/vector");
  const client = new PGlite({
    dataDir: dataDir === "memory://" ? undefined : dataDir,
    extensions: { vector },
  });
  pgliteClientForTests = client;
  const database: PgliteDatabase<typeof schema> = drizzlePGlite({ client, schema });
  return registerDatabaseCloser(database as Database, async () => {
    await client.close();
  });
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

/**
 * Whether to keep TLS but skip server-certificate verification.
 *
 * Managed providers like Railway terminate the public TCP proxy with a
 * self-signed certificate, so strict CA verification fails even though the
 * connection is fully encrypted. Opt in — per the provider's own guidance —
 * with `DATABASE_SSL_NO_VERIFY=true` or `?sslmode=no-verify` on the URL. The
 * default stays strict; this never disables encryption (only verification).
 */
export function shouldSkipTlsVerification(url: string): boolean {
  if (process.env.DATABASE_SSL_NO_VERIFY === "true") {
    return true;
  }
  try {
    return new URL(url).searchParams.get("sslmode") === "no-verify";
  } catch {
    return false;
  }
}

/**
 * Enforce TLS on remote Postgres connections (D-2 / SOC2 CC6.7).
 *
 * Local (127.0.0.1 / localhost) connections may run without TLS for dev.
 * Anything else must use TLS — both via the URL `sslmode` parameter (so it
 * survives external connection-pool configs) AND via the `ssl` option on the
 * pg driver (so the handshake is enforced even if the parameter is dropped by
 * a proxy). We fail closed: `sslmode=disable`/`allow` is rejected outright, and
 * certificate verification stays on (`rejectUnauthorized: true`) unless the
 * operator explicitly opts into `no-verify` for a self-signed managed proxy
 * (the connection remains encrypted; only CA verification is relaxed).
 */
export function enforceTlsForRemote(url: string): {
  url: string;
  ssl: PoolConfig["ssl"];
} {
  if (isLocalTcpPostgresUrl(url)) {
    return { url, ssl: undefined };
  }
  const skipVerify = shouldSkipTlsVerification(url);
  let normalized = url;
  try {
    const parsed = new URL(url);
    const sslmode = parsed.searchParams.get("sslmode");
    if (sslmode === "disable" || sslmode === "allow") {
      throw new Error(
        `Refusing to connect: remote DATABASE_URL has sslmode=${sslmode}. Remote Postgres connections must use TLS (SOC2 CC6.7).`,
      );
    }
    if (!sslmode) {
      parsed.searchParams.set("sslmode", skipVerify ? "no-verify" : "require");
      normalized = parsed.toString();
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Refusing to connect")) {
      throw err;
    }
    // URL parse failure — fall through with original string; pg will reject.
  }
  return {
    url: normalized,
    ssl: { rejectUnauthorized: !skipVerify },
  };
}

/**
 * pg-pool `onConnect` hook: apply server-side idle-session timeouts to every
 * fresh connection. Long-running Node services (agent-server, gateways,
 * daemons) hold pooled connections on the shared Postgres. A checkout that's
 * never released, or a transaction abandoned open, would otherwise sit forever
 * and can exhaust max_connections ("too many clients already"). The pool reaps
 * its OWN idle connections within seconds, so these server-side timeouts only
 * ever fire on genuinely leaked/abandoned sessions — reclaiming the slot.
 *
 * Registered as `onConnect` (NOT `pool.on("connect")`): pg-pool awaits this
 * hook to completion before handing the fresh client to a waiting checkout, so
 * the SET can never overlap the checkout's first query on the same client —
 * the overlap node-pg deprecates ("Calling client.query() when the client is
 * already executing a query…", removed in pg@9). idle_session_timeout is PG14+
 * (idle_in_transaction_session_timeout is PG9.6+); the catch keeps the hook a
 * no-op on older servers instead of failing the connection.
 */
export async function applyIdleSessionTimeouts(client: {
  query: (text: string) => Promise<unknown>;
}): Promise<void> {
  try {
    await client.query(
      "SET idle_session_timeout = '10min'; SET idle_in_transaction_session_timeout = '5min'",
    );
  } catch (err) {
    logger.debug("[db] could not set idle session timeouts", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function createPgPool(url: string, hyperdriveUrl?: string): PgPool {
  const env = getCloudAwareEnv();
  const inWorkerRuntime = isCloudflareWorkerRuntime();
  const isLocalTcp = isLocalTcpPostgresUrl(url);
  // Hyperdrive proxies to the origin (pooling + TLS); the Worker connects to its
  // local plaintext endpoint, so bypass the remote-TLS enforcement.
  const tls = hyperdriveUrl ? { url: hyperdriveUrl, ssl: undefined } : enforceTlsForRemote(url);
  const options: PoolConfig = { connectionString: tls.url };
  if (tls.ssl) options.ssl = tls.ssl;
  // Identify our connections in pg_stat_activity. Railway sets
  // RAILWAY_SERVICE_NAME per service, so on a shared Postgres a connection leak
  // (or a service hogging the pool) can be attributed to the right service
  // instead of showing as an anonymous "" backend — which is exactly what made
  // the 2026-06-19 "too many clients" incident hard to triage.
  options.application_name = env.RAILWAY_SERVICE_NAME || "eliza-cloud-shared";

  if (inWorkerRuntime) {
    options.max = parsePositiveInteger(env.LOCAL_PG_POOL_MAX, 1);
    // Discard connections after a single query — Workers can't reliably
    // share I/O across requests. EXCEPT against local PGlite: the PGlite
    // socket bridge is fragile and creating a fresh TCP connection per
    // query causes "Connection terminated unexpectedly" mid-stream. Local
    // dev uses long-lived connections instead; the per-request isolation
    // workers need only matters for shared remote pools.
    options.maxUses = isLocalTcp ? 0 : 1;
    options.connectionTimeoutMillis = 30_000;
  }

  if (isLocalTcp) {
    options.max = parsePositiveInteger(env.LOCAL_PG_POOL_MAX, 8);
    // Keep idle connections around long enough that consecutive requests
    // reuse them instead of churning the PGlite socket bridge. Worker-runtime
    // already overrides max + maxUses above; this just bumps idle to 30s.
    options.idleTimeoutMillis = 30_000;
    options.connectionTimeoutMillis = 30_000;
  }

  // Skip on Workers (maxUses=1, can't leak, and we don't want an extra
  // round-trip per request) and on local PGlite.
  if (!inWorkerRuntime && !isLocalTcp) {
    options.onConnect = applyIdleSessionTimeouts;
  }

  const pool = new PgPool(options);
  // node-pg emits 'error' on an IDLE pooled client that the server/proxy drops
  // (Railway/Hyperdrive recycling a connection, or the PGlite socket bridge
  // closing one mid-suite). Without a listener, that 'error' is unhandled and
  // crashes the whole worker request/process. Swallow+log it: the pool evicts
  // the dead client and the next query transparently opens a fresh one.
  pool.on("error", (err) => {
    logger.warn("[db] idle pg client error (evicted, will reconnect)", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  if (isLocalTcp) {
    disableLocalPreparedStatements(pool, { simpleQueryMode: inWorkerRuntime });
  }
  return pool;
}

/**
 * Create a database connection from a URL
 */
function createConnection(url: string): Database {
  if (url.startsWith("pglite://")) {
    if (isCloudflareWorkerRuntime()) {
      throw new Error("pglite:// URLs are local-only and cannot run inside a Cloudflare Worker.");
    }
    return createPGliteClient(parsePGliteDataDir(url));
  }

  // Remote Postgres (Railway): on workerd a direct node-pg TCP
  // connection terminates mid-query, so prefer a Cloudflare Hyperdrive binding
  // when present and let it proxy to the origin.
  const hyperdriveUrl = getCloudBinding<{ connectionString?: string }>(
    "HYPERDRIVE",
  )?.connectionString;
  // Fail closed: a direct node-pg TCP/TLS connection to an external Postgres
  // terminates mid-query on workerd (#8629). If we're in a Worker reaching a
  // remote origin without a Hyperdrive binding, refuse loudly instead of
  // silently opening a doomed per-request connection.
  if (isCloudflareWorkerRuntime() && !hyperdriveUrl && !isLocalTcpPostgresUrl(url)) {
    throw new Error(
      "Refusing direct node-pg to external Postgres from a Worker: HYPERDRIVE binding missing. " +
        "Bind [[hyperdrive]] in wrangler.toml so the Worker proxies to the origin (see #8629).",
    );
  }
  const pool = createPgPool(url, hyperdriveUrl);
  return registerDatabaseCloser(drizzleNode(pool, { schema }) as Database, () => pool.end());
}

// ============================================================================
// Connection Manager
// ============================================================================

/**
 * Per-request DB cache for the Workers runtime.
 *
 * Cloudflare Workers refuse to share I/O objects (TCP sockets, WebSockets,
 * streams) across requests — a `Database` whose underlying pool was opened
 * during request A throws when used in request B with:
 *
 *   "Cannot perform I/O on behalf of a different request. (I/O type: Native)"
 *
 * Bootstrap middleware enters `runWithDbCacheAsync(...)` once per fetch
 * invocation so each request gets its own `Map<url, Database>`. Outside
 * Workers (Node, tests) the ALS store is empty and the manager falls back to
 * a process-level singleton cache.
 */
const dbCacheAls = new AsyncLocalStorage<Map<string, Database>>();

export async function runWithDbCacheAsync<T>(fn: () => Promise<T>): Promise<T> {
  return await dbCacheAls.run(new Map(), fn);
}

/**
 * Singleton connection manager for all database connections.
 *
 * On Workers the per-request store from `dbCacheAls` is preferred; the
 * module-level `connections` Map is only used in Node/local where pools
 * can safely live for the lifetime of the process.
 */
class DatabaseConnectionManager {
  private connections: Map<string, Database> = new Map();
  private initialized = false;

  /**
   * Get or create a database connection.
   *
   * Workers: caches in the request-scoped ALS store so I/O objects stay
   * within the originating request handler. Falls through to a fresh
   * connection if no ALS store exists (e.g. cron / scheduled handlers
   * that didn't enter the bootstrap middleware).
   */
  getConnection(url: string): Database {
    if (isCloudflareWorkerRuntime()) {
      const requestCache = dbCacheAls.getStore();
      if (requestCache) {
        let cached = requestCache.get(url);
        if (!cached) {
          cached = createConnection(url);
          requestCache.set(url, cached);
        }
        return cached;
      }
      return createConnection(url);
    }

    if (!this.connections.has(url)) {
      this.connections.set(url, createConnection(url));
    }
    return this.connections.get(url)!;
  }

  /**
   * Get write connection.
   */
  getWriteConnection(): Database {
    const url = getPrimaryDatabaseUrl();
    return this.getConnection(url);
  }

  /**
   * Get read connection.
   */
  getReadConnection(): Database {
    const url = getPrimaryDatabaseUrl();
    return this.getConnection(url);
  }

  /**
   * Get connection info for debugging
   */
  getConnectionInfo(): {
    databaseUrlConfigured: boolean;
  } {
    const env = getCloudAwareEnv();
    return {
      databaseUrlConfigured: !!applyDatabaseUrlFallback(env),
    };
  }

  /**
   * Close process-level cached connections.
   *
   * Used by local test/dev harnesses that bring up and tear down ephemeral
   * Postgres/PGlite servers in the same Node/Bun process. Workers use
   * request-scoped caches and do not share this singleton pool.
   */
  async closeAll(): Promise<void> {
    const databases = Array.from(this.connections.values());
    this.connections.clear();
    const requestCache = dbCacheAls.getStore();
    requestCache?.clear();
    await Promise.all(
      databases.map(async (database) => {
        await databaseClosers.get(database)?.();
      }),
    );
  }
}

const connectionManager = new DatabaseConnectionManager();

// ============================================================================
// Exported Database Instances
// ============================================================================

/**
 * Primary database - routes to the primary write connection.
 * Equivalent to `dbWrite`; prefer `dbRead` / `dbWrite` for read/write intent clarity.
 */
export const db = new Proxy({} as Database, {
  get: (_, prop) => {
    const database = connectionManager.getWriteConnection();
    const value = database[prop as keyof typeof database];
    return typeof value === "function" ? value.bind(database) : value;
  },
});

/**
 * Read-intent database connection.
 * Currently uses the primary DATABASE_URL; keep this alias for repository
 * read/write intent clarity after regional replicas were removed.
 *
 * @example
 * // Read-intent query
 * const users = await dbRead.query.users.findMany();
 */
export const dbRead = new Proxy({} as Database, {
  get: (_, prop) => {
    const database = connectionManager.getReadConnection();
    const value = database[prop as keyof typeof database];
    return typeof value === "function" ? value.bind(database) : value;
  },
});

/**
 * Write database - routes to the primary connection.
 * Use for INSERT, UPDATE, DELETE operations
 *
 * @example
 * // Write to primary
 * await dbWrite.insert(users).values({ name: 'John' });
 */
export const dbWrite = new Proxy({} as Database, {
  get: (_, prop) => {
    const database = connectionManager.getWriteConnection();
    const value = database[prop as keyof typeof database];
    return typeof value === "function" ? value.bind(database) : value;
  },
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get connection info for debugging/monitoring
 */
export function getDbConnectionInfo() {
  return connectionManager.getConnectionInfo();
}

/**
 * Close cached process-local DB pools for local test/dev teardown.
 */
export async function closeDatabaseConnectionsForTests(): Promise<void> {
  await connectionManager.closeAll();
}

/**
 * TEST-ONLY: the raw PGlite instance behind the write connection, forcing the
 * lazy connection to materialize first. Throws when the configured database
 * is not PGlite — pushing test DDL into a shared Postgres would mutate schema
 * other suites depend on, so this fails closed instead of returning null.
 */
export function getPgliteClientForTests(): import("@electric-sql/pglite").PGlite {
  connectionManager.getWriteConnection();
  if (!pgliteClientForTests) {
    throw new Error(
      "getPgliteClientForTests requires a PGlite-backed database (DATABASE_URL=pglite://…)",
    );
  }
  return pgliteClientForTests;
}

// ============================================================================
// Type Exports
// ============================================================================

export type { Database, DbTransaction };
