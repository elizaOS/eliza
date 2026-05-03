/**
 * Database Client with Multi-Region Support
 *
 * Multi-Region Setup:
 * - NA (North America): Primary database (read/write)
 * - EU (Europe): Logical replication read-only replica (pub/sub from NA)
 * - Writes ALWAYS go to NA primary regardless of request region
 * - EU reads go to EU replica for low latency
 * - NA/APAC reads go to NA primary
 *
 * Environment Variables:
 * - DATABASE_URL           : Primary database in NA (required) - handles all writes and NA reads
 * - DATABASE_URL_EU_READ   : EU region read replica (optional, for low-latency EU reads)
 * - DATABASE_REGION        : Explicit region override ("na" | "eu" | "apac"). On Cloudflare
 *                            Workers this is set per-environment via wrangler.toml.
 * - CF_REGION              : Auto-populated colo-derived region hint (Workers).
 *
 * @module db/client
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePGlite } from "drizzle-orm/pglite";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";
import { Pool as PgPool, type PoolConfig } from "pg";
import ws from "ws";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
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

type DatabaseRegion = "na" | "eu" | "apac";
type DatabaseRole = "read" | "write";

// ============================================================================
// Region Detection
// ============================================================================

/**
 * Detect the current database region.
 *
 * On Cloudflare Workers the region is read from `DATABASE_REGION` (set per
 * environment in wrangler.toml) or `CF_REGION` (colo hint). Defaults to NA.
 */
function detectRegion(): DatabaseRegion {
  const env = getCloudAwareEnv();
  const explicitRegion = (env.DATABASE_REGION || env.CF_REGION)?.toLowerCase();
  if (explicitRegion === "eu" || explicitRegion === "na" || explicitRegion === "apac") {
    return explicitRegion;
  }

  return "na";
}

/**
 * Get current region (cached for performance)
 */
let _cachedRegion: DatabaseRegion | null = null;
export function getCurrentRegion(): DatabaseRegion {
  if (_cachedRegion === null) {
    _cachedRegion = detectRegion();
  }
  return _cachedRegion;
}

// ============================================================================
// Database URL Resolution
// ============================================================================

/**
 * Get the appropriate database URL for a given region and role.
 *
 * IMPORTANT: Write operations ALWAYS go to the primary NA database.
 * EU is a read-only logical replication, so writes must never be routed there.
 *
 * Read routing:
 * - EU requests → DATABASE_URL_EU_READ (if set) → DATABASE_URL (NA primary)
 * - NA/APAC requests → DATABASE_URL (NA primary)
 *
 * Write routing:
 * - ALL requests → DATABASE_URL (NA primary)
 */
function getDatabaseUrl(region: DatabaseRegion, role: DatabaseRole): string {
  // CRITICAL: Writes ALWAYS go to the primary database (NA)
  // EU is read-only via logical replication, so we must never write there
  if (role === "write") {
    return getPrimaryDatabaseUrl();
  }

  // For EU reads, use EU replica if available
  if (region === "eu") {
    const euReadUrl = getCloudAwareEnv().DATABASE_URL_EU_READ;
    if (euReadUrl) {
      return euReadUrl;
    }
  }

  // All other reads (NA, APAC, or EU without replica) go to NA primary
  return getPrimaryDatabaseUrl();
}

/**
 * Get the primary database URL (always required)
 */
function getPrimaryDatabaseUrl(): string {
  const url = applyDatabaseUrlFallback(getCloudAwareEnv());
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Use a Neon URL for cloud, a `pglite://<dir>` URL for embedded local dev, or a vanilla `postgresql://` URL.",
    );
  }
  return url;
}

// ============================================================================
// Database Connection Factory
// ============================================================================

/**
 * Checks if a database URL is for Neon serverless
 */
function isNeonDatabase(url: string): boolean {
  return url.includes("neon.tech") || url.includes("neon.database");
}

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
  return drizzlePGlite({ client, schema }) as unknown as Database;
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

function createPgPool(url: string): PgPool {
  const options: PoolConfig = { connectionString: url };
  const env = getCloudAwareEnv();
  const inWorkerRuntime = isCloudflareWorkerRuntime();

  if (inWorkerRuntime) {
    options.max = parsePositiveInteger(env.LOCAL_PG_POOL_MAX, 1);
    options.maxUses = 1;
    options.connectionTimeoutMillis = 30_000;
  }

  if (isLocalTcpPostgresUrl(url)) {
    options.max = parsePositiveInteger(env.LOCAL_PG_POOL_MAX, 8);
    options.idleTimeoutMillis = 1_000;
    options.connectionTimeoutMillis = 30_000;
  }
  const pool = new PgPool(options);
  if (isLocalTcpPostgresUrl(url)) {
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

  if (isNeonDatabase(url)) {
    // WebSocket pool both on Workers and Node — neon-http does not implement
    // `db.transaction(...)`, which breaks `writeTransaction` in db/helpers.ts.
    if (typeof WebSocket === "undefined") {
      neonConfig.webSocketConstructor = ws;
    }
    const pool = new NeonPool({ connectionString: url });
    return drizzleNeon(pool, { schema }) as unknown as Database;
  }

  const pool = createPgPool(url);
  return drizzleNode(pool, { schema }) as unknown as Database;
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

export function runWithDbCache<T>(fn: () => T): T {
  return dbCacheAls.run(new Map(), fn);
}

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
   * Get write connection - ALWAYS routes to NA primary.
   * EU is read-only via logical replication.
   */
  getWriteConnection(): Database {
    // Writes always go to primary, regardless of detected region
    const url = getPrimaryDatabaseUrl();
    return this.getConnection(url);
  }

  /**
   * Get read connection for current region
   */
  getReadConnection(): Database {
    const region = getCurrentRegion();
    const url = getDatabaseUrl(region, "read") || getPrimaryDatabaseUrl();
    return this.getConnection(url);
  }

  /**
   * Get connection for specific region and role.
   * Note: Write operations are always routed to NA primary regardless of region.
   */
  getRegionalConnection(region: DatabaseRegion, role: DatabaseRole): Database {
    // For writes, always use primary regardless of requested region
    // EU is read-only via logical replication
    if (role === "write") {
      return this.getConnection(getPrimaryDatabaseUrl());
    }

    const url = getDatabaseUrl(region, role);
    return this.getConnection(url);
  }

  /**
   * Get connection info for debugging
   */
  getConnectionInfo(): {
    currentRegion: DatabaseRegion;
    region: string | undefined;
    hasEuReadReplica: boolean;
    writesRouteTo: "na_primary";
    readsRouteToEu: boolean;
  } {
    const currentRegion = getCurrentRegion();
    const env = getCloudAwareEnv();
    const hasEuReadReplica = !!env.DATABASE_URL_EU_READ;
    return {
      currentRegion,
      region: env.CF_REGION || env.DATABASE_REGION,
      hasEuReadReplica,
      writesRouteTo: "na_primary", // Writes always go to NA primary
      readsRouteToEu: currentRegion === "eu" && hasEuReadReplica,
    };
  }
}

const connectionManager = new DatabaseConnectionManager();

// ============================================================================
// Exported Database Instances
// ============================================================================

/**
 * Primary database - routes to the NA primary write connection.
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
 * Read database - Routes to read replica in current region
 * Use for SELECT queries, reports, analytics
 *
 * @example
 * // Read from replica
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
 * Write database - Routes to primary in current region
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
// Regional Database Accessors
// ============================================================================

/**
 * EU region database connections.
 * Note: EU is a read-only replica. write operations are routed to NA primary.
 */
export const dbEU = {
  /** EU read replica for low-latency reads in Europe */
  read: new Proxy({} as Database, {
    get: (_, prop) => {
      const database = connectionManager.getRegionalConnection("eu", "read");
      const value = database[prop as keyof typeof database];
      return typeof value === "function" ? value.bind(database) : value;
    },
  }),
};

/**
 * NA region database connections
 */
export const dbNA = {
  read: new Proxy({} as Database, {
    get: (_, prop) => {
      const database = connectionManager.getRegionalConnection("na", "read");
      const value = database[prop as keyof typeof database];
      return typeof value === "function" ? value.bind(database) : value;
    },
  }),
  write: new Proxy({} as Database, {
    get: (_, prop) => {
      const database = connectionManager.getRegionalConnection("na", "write");
      const value = database[prop as keyof typeof database];
      return typeof value === "function" ? value.bind(database) : value;
    },
  }),
};

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
 * Execute a read query (uses read replica)
 */
export async function withReadDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  return fn(connectionManager.getReadConnection());
}

/**
 * Execute a write query (uses primary)
 */
export async function withWriteDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  return fn(connectionManager.getWriteConnection());
}

/**
 * Execute with explicit region selection
 */
export async function withRegionalDb<T>(
  region: DatabaseRegion,
  role: DatabaseRole,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return fn(connectionManager.getRegionalConnection(region, role));
}

// ============================================================================
// Type Exports
// ============================================================================

export type { Database, DatabaseRegion, DatabaseRole, DbTransaction };
