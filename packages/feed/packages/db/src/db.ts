/**
 * Database runtime (connection management + mode-aware client)
 *
 * This module exists to avoid internal circular dependencies by ensuring
 * other modules can import `db`/`Database` without importing `src/index.ts`.
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDrizzleClient, type DrizzleClient } from "./client";
import { createJsonClient } from "./json-client";
import {
  clearJsonStorage,
  exportJsonState,
  getJsonState,
  getJsonStoragePath,
  initJsonStorage,
  loadJsonSnapshot,
  saveJsonSnapshot,
} from "./json-storage";
import { logger } from "./logger";
import * as schema from "./schema";

// ============================================================================
// Types
// ============================================================================

export type Database = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// ============================================================================
// Connection Management
// ============================================================================

// Global state for database connections (serverless-safe)
// Using a type assertion here is safe because we're extending globalThis
const globalForDb = globalThis as typeof globalThis & {
  postgresClient: ReturnType<typeof postgres> | undefined;
  drizzleDb: Database | undefined;
  db: DrizzleClient | undefined;
  // Read replica support for high-scale deployments
  readReplicaClient: ReturnType<typeof postgres> | undefined;
  readReplicaDrizzle: Database | undefined;
  readReplicaDb: DrizzleClient | undefined;
  primaryDbVersion: number | undefined;
  readReplicaDbVersion: number | undefined;
};

if (globalForDb.primaryDbVersion === undefined) {
  globalForDb.primaryDbVersion = 0;
}

if (globalForDb.readReplicaDbVersion === undefined) {
  globalForDb.readReplicaDbVersion = 0;
}

const isBuildTime = process.env.NEXT_PHASE === "phase-production-build";

// ============================================================================
// Shared Utilities
// ============================================================================

function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test" ||
    (typeof process !== "undefined" && process.argv?.join(" ").includes("test"))
  );
}

/** Hard cap so misconfiguration cannot exhaust Postgres max_connections */
const DATABASE_POOL_MAX_CAP = 500;

function parsePositiveIntEnv(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(`Invalid ${key} value: "${raw}", using default`);
    return undefined;
  }
  return Math.min(n, DATABASE_POOL_MAX_CAP);
}

// ============================================================================
// Primary/Master Configuration
// ============================================================================

function getConnectionUrl(): string {
  return process.env.DATABASE_URL || "postgresql://localhost:5432/feed";
}

function getReadReplicaUrl(): string | undefined {
  const url = process.env.DATABASE_READ_REPLICA_URL?.trim();
  return url ? url : undefined;
}

// ============================================================================
// Read Replica/Slave Configuration
// ============================================================================

// ============================================================================
// Postgres Client Configuration
// ============================================================================

function getPostgresClientConfig(
  url: string,
  role: "primary" | "replica",
): postgres.Options<{}> {
  const isTest = isTestEnvironment();
  const isProd = process.env.NODE_ENV === "production";

  // Determine if this is a local database connection
  const isLocalhost = url.includes("localhost") || url.includes("127.0.0.1");

  // Check if SSL is already specified in the URL (sslmode=require or ssl=true)
  const hasExplicitSSL =
    url.includes("sslmode=require") || url.includes("ssl=true");

  // Check for cloud database providers that require SSL (Neon, Supabase, etc.)
  const isCloudProvider =
    url.includes("neon.tech") ||
    url.includes("supabase.co") ||
    url.includes("pooler.supabase") ||
    url.includes("db.bit.io") ||
    url.includes(".postgres.database.azure.com") ||
    url.includes(".rds.amazonaws.com");

  // SSL is required for:
  // - URL explicitly specifies sslmode=require
  // - Production with non-localhost connections
  // - Any cloud database provider (even in development)
  const sslMode: "require" | false =
    hasExplicitSSL || (!isLocalhost && (isProd || isCloudProvider))
      ? "require"
      : false;

  // Node serves many concurrent requests in one process; without a bounded pool we'd get
  // one connection per in-flight query and exhaust Neon/Postgres limits. Pool caps connections
  // and queues work. Defaults stay small so (instances × pool max) stays within Neon caps.
  const isPooler =
    url.includes("pooler") ||
    url.includes("pgbouncer") ||
    url.includes("?pgbouncer=true") ||
    url.includes("?pgbouncer=1") ||
    url.includes("-pooler.") ||
    url.includes("pooler.supabase") ||
    url.includes("transaction-pooler");

  const envKey =
    role === "primary" ? "DATABASE_POOL_MAX" : "DATABASE_READ_REPLICA_POOL_MAX";
  const envMax = parsePositiveIntEnv(envKey);

  // Pool size lookup table for clarity (avoids nested ternaries)
  const POOL_DEFAULTS = {
    pooler: {
      primary: { prod: 10, test: 2, dev: 8 },
      replica: { prod: 15, test: 2, dev: 12 },
    },
    direct: {
      primary: { prod: 8, test: 5, dev: 10 },
      replica: { prod: 12, test: 5, dev: 15 },
    },
  };

  let poolMax: number;
  if (envMax !== undefined) {
    poolMax = envMax;
  } else {
    const connectionType = isPooler ? "pooler" : "direct";
    const env = isProd ? "prod" : isTest ? "test" : "dev";
    poolMax = POOL_DEFAULTS[connectionType][role][env];
  }

  // Connection params
  const applicationName =
    role === "replica" && process.env.DATABASE_READ_REPLICA_APPLICATION_NAME
      ? process.env.DATABASE_READ_REPLICA_APPLICATION_NAME
      : (process.env.DATABASE_APPLICATION_NAME ?? "feed");

  const applyGuardrails =
    !isTest &&
    (process.env.NODE_ENV === "production" ||
      ["true", "1", "yes"].includes(
        process.env.DATABASE_SESSION_GUARDRAILS?.toLowerCase() ?? "",
      ));

  const connectionParams: Partial<postgres.ConnectionParameters> = {
    application_name: applicationName,
  };

  if (applyGuardrails) {
    const statementMs =
      parsePositiveIntEnv("DATABASE_STATEMENT_TIMEOUT_MS") ?? 60_000;
    const lockMs = parsePositiveIntEnv("DATABASE_LOCK_TIMEOUT_MS") ?? 10_000;
    const idleInTxMs =
      parsePositiveIntEnv("DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS") ?? 60_000;
    if (statementMs > 0) connectionParams.statement_timeout = statementMs;
    if (lockMs > 0) connectionParams.lock_timeout = lockMs;
    if (idleInTxMs > 0)
      connectionParams.idle_in_transaction_session_timeout = idleInTxMs;
  }

  logger.debug(`[Drizzle] Creating ${role} postgres client`, {
    isProd,
    isLocalhost,
    isCloudProvider,
    hasExplicitSSL,
    sslMode,
    isPooler,
    poolMax,
    urlHost: url.split("@")[1]?.split("/")[0] || "unknown",
  });

  return {
    max: poolMax,
    // Shorter idle timeout for serverless to release connections faster
    idle_timeout: isProd ? 20 : 15,
    connect_timeout: 10,
    ssl: sslMode,
    transform: { undefined: null },
    onnotice: () => {},
    connection: connectionParams,
  };
}

// ============================================================================
// Primary/Master Client Creation
// ============================================================================

function createPostgresClient(): ReturnType<typeof postgres> {
  const url = getConnectionUrl();
  return postgres(url, getPostgresClientConfig(url, "primary"));
}

function getPostgresClient(): ReturnType<typeof postgres> | null {
  if (isBuildTime && !isTestEnvironment()) {
    return null;
  }

  if (!globalForDb.postgresClient) {
    const url = getConnectionUrl();
    if (!url || url === "postgresql://localhost:5432/feed") {
      if (isTestEnvironment()) {
        throw new Error("DATABASE_URL is required in test environment");
      }
      return null;
    }

    globalForDb.postgresClient = createPostgresClient();
    logger.info("[Drizzle] Database connection created");
  }

  return globalForDb.postgresClient;
}

function getDrizzleInstance(): Database | null {
  if (!globalForDb.drizzleDb) {
    const client = getPostgresClient();
    if (!client) return null;

    globalForDb.drizzleDb = drizzle(client, {
      schema,
      logger: process.env.DB_LOG_QUERIES === "true",
    });
  }

  return globalForDb.drizzleDb;
}

// ============================================================================
// Read Replica/Slave Client Creation
// ============================================================================

/**
 * Create a read replica postgres client
 * Uses separate connection pool for read-heavy operations
 */
function createReadReplicaClient(url: string): ReturnType<typeof postgres> {
  return postgres(url, getPostgresClientConfig(url, "replica"));
}

/**
 * Get read replica Drizzle instance
 * Returns null when no read replica is configured
 */
function getReadReplicaDrizzle(): Database | null {
  const replicaUrl = getReadReplicaUrl();
  if (!replicaUrl) return null;

  if (!globalForDb.readReplicaDrizzle) {
    if (!globalForDb.readReplicaClient) {
      const client = createReadReplicaClient(replicaUrl);
      globalForDb.readReplicaClient = client;
    }

    if (!globalForDb.readReplicaClient) return null;

    globalForDb.readReplicaDrizzle = drizzle(globalForDb.readReplicaClient, {
      schema,
      logger: process.env.DB_LOG_QUERIES === "true",
    });

    logger.info("[Drizzle] Read replica connection created");
  }

  return globalForDb.readReplicaDrizzle;
}

function getPrimaryDbVersion(): number {
  return globalForDb.primaryDbVersion ?? 0;
}

function bumpPrimaryDbVersion(): void {
  globalForDb.primaryDbVersion = getPrimaryDbVersion() + 1;
}

/**
 * Get current read replica version (used by proxy for cache invalidation)
 */
export function getReadReplicaDbVersion(): number {
  return globalForDb.readReplicaDbVersion ?? 0;
}

function bumpReadReplicaDbVersion(): void {
  globalForDb.readReplicaDbVersion = getReadReplicaDbVersion() + 1;
}

/**
 * Create a lazy proxy that defers getDbClient() until method invocation.
 * WHY: Prevents eager client creation during property access.
 * Client is only created when a method is actually called (query executes).
 *
 * NOTE: This function uses READ_METHODS and WRITE_METHODS which are defined later.
 * The actual implementation is deferred until those constants are available.
 */
function createLazyPrimaryClientProxy(): DrizzleClient {
  const handler: ProxyHandler<DrizzleClient> = {
    get(_target, prop: string | symbol) {
      // In JSON/memory mode, use the JSON client
      if (currentStorageMode !== "postgres" && jsonClient) {
        return jsonClient[prop as keyof DrizzleClient];
      }

      // ✅ Return a lazy property proxy that defers getDbClient() until method is called
      // This ensures client is only created when db.user.findMany() is called,
      // not when db.user is accessed
      return createLazyPropertyProxy(prop);
    },
  };

  const proxyTarget: Partial<DrizzleClient> = {};
  return new Proxy(proxyTarget, handler) as DrizzleClient;
}

/**
 * Create a lazy proxy for a specific property that defers getDbClient() until accessed.
 * For table repositories, this returns a proxy that defers until a method is called.
 *
 * WHY: This ensures client is only created when db.user.findMany() is called,
 * not when db.user is accessed. This is truly lazy.
 */
function createLazyPropertyProxy(prop: string | symbol): unknown {
  // Return a proxy that defers getDbClient() until a method is accessed
  // This proxy will only call getDbClient() when a method is accessed (e.g., db.user.findMany)
  return new Proxy({} as Record<string, never>, {
    get(_target, method: string | symbol) {
      // ✅ Only NOW do we call getDbClient() - when a method on the property is accessed
      // This is truly lazy: client is created when db.user.findMany() is called,
      // not when db.user is accessed
      const client = getDbClient();
      if (!client) {
        if (isBuildTime) {
          return () => Promise.resolve(null);
        }
        throw new Error(
          "Database not initialized. Check DATABASE_URL or use initializeJsonMode().",
        );
      }

      const value = client[prop as keyof DrizzleClient];
      if (value && typeof value === "object") {
        const methodValue = (value as Record<PropertyKey, unknown>)[method];
        if (typeof methodValue === "function") {
          return methodValue.bind(value);
        }
        return methodValue;
      }
      if (typeof value === "function") {
        return value.bind(client);
      }
      return value;
    },
  });
}

/**
 * Get read replica DrizzleClient (cached)
 * Falls back to lazy primary proxy if read replica not configured
 *
 * WHY: Keeps fallback for dev environments, but makes it lazy.
 * Client is only created when query executes, not during property access.
 */
function getReadReplicaDbClient(): DrizzleClient | null {
  const replica = getReadReplicaDrizzle();
  if (!replica) return null;

  if (!globalForDb.readReplicaDb) {
    globalForDb.readReplicaDb = createDrizzleClient(replica);
    // Increment version to invalidate bound method caches
    bumpReadReplicaDbVersion();
  }

  return globalForDb.readReplicaDb;
}

/**
 * Get the primary (write) database client (cached).
 *
 * WHY: Caches the client in global state to avoid recreating it on every access.
 * The client is created lazily - only when this function is called, not when
 * the module is loaded. This is used by lazy proxies to create the client
 * only when queries execute.
 *
 * NOTE: This function is called by lazy proxies when methods are accessed,
 * ensuring client is only created when needed, not during property access.
 */
function getDbClient(): DrizzleClient | null {
  if (!globalForDb.db) {
    const drizzleInstance = getDrizzleInstance();
    if (!drizzleInstance) return null;

    globalForDb.db = createDrizzleClient(drizzleInstance);
  }

  return globalForDb.db;
}

// ============================================================================
// Retry Logic
// ============================================================================

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

const defaultRetryConfig: RetryConfig = isTestEnvironment()
  ? { maxRetries: 2, initialDelayMs: 50, maxDelayMs: 500, jitter: false }
  : { maxRetries: 5, initialDelayMs: 100, maxDelayMs: 5000, jitter: true };

async function withRetryInternal<T>(
  operation: () => Promise<T>,
  config: RetryConfig = defaultRetryConfig,
): Promise<T> {
  let lastError: Error | undefined;
  let delay = config.initialDelayMs;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Retry on transient connection errors
      // Match specific error patterns to avoid retrying non-retryable errors
      const errorMsg = lastError.message.toLowerCase();
      const isRetryable =
        (errorMsg.includes("connection") &&
          (errorMsg.includes("closed") ||
            errorMsg.includes("terminated") ||
            errorMsg.includes("refused") ||
            errorMsg.includes("reset"))) ||
        (errorMsg.includes("timeout") &&
          (errorMsg.includes("connection") || errorMsg.includes("query"))) ||
        errorMsg.includes("deadlock") ||
        errorMsg.includes("econnrefused") ||
        errorMsg.includes("econnreset") ||
        errorMsg.includes("etimedout") ||
        // SSL connection errors common with Neon's pooler (excludes certificate validation errors)
        (errorMsg.includes("ssl") &&
          (errorMsg.includes("connection") ||
            errorMsg.includes("handshake") ||
            errorMsg.includes("reset") ||
            errorMsg.includes("closed"))) ||
        // Connection limit errors
        errorMsg.includes("too many connections") ||
        errorMsg.includes("connection limit");

      if (!isRetryable || attempt === config.maxRetries) {
        throw lastError;
      }

      logger.warn(`[Drizzle] Retry ${attempt + 1}/${config.maxRetries}`, {
        error: lastError.message,
      });

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, config.maxDelayMs);
      if (config.jitter) delay += Math.random() * delay * 0.1;
    }
  }

  throw lastError;
}

// ============================================================================
// Storage Mode Management
// ============================================================================

export type StorageMode = "postgres" | "json" | "memory";

// Global storage mode
let currentStorageMode: StorageMode = "postgres";
let jsonClient: DrizzleClient | null = null;

/**
 * Initialize JSON storage mode.
 * All database operations will use JSON file storage instead of PostgreSQL.
 *
 * @param basePath - Directory to store JSON files
 * @param options - Configuration options
 */
export async function initializeJsonMode(
  basePath: string,
  options: { autoSave?: boolean } = {},
): Promise<void> {
  await initJsonStorage(basePath, options);
  currentStorageMode = "json";
  jsonClient = createJsonClient();
  logger.info("[DB] Initialized JSON storage mode", { basePath });
}

/**
 * Initialize memory storage mode (JSON without persistence).
 * Useful for testing.
 */
export async function initializeMemoryMode(): Promise<void> {
  await initJsonStorage("/tmp/feed-memory", { autoSave: false });
  currentStorageMode = "memory";
  jsonClient = createJsonClient();
  logger.info("[DB] Initialized memory storage mode");
}

/**
 * Reset to PostgreSQL mode.
 */
export function resetToPostgresMode(): void {
  currentStorageMode = "postgres";
  jsonClient = null;
  clearJsonStorage();
  logger.info("[DB] Reset to PostgreSQL mode");
}

/** Get current storage mode */
export function getStorageMode(): StorageMode {
  return currentStorageMode;
}

/** Check if using JSON/memory mode */
export function isSimulationMode(): boolean {
  return currentStorageMode === "json" || currentStorageMode === "memory";
}

// Re-export JSON storage utilities
export {
  exportJsonState,
  getJsonState,
  getJsonStoragePath,
  loadJsonSnapshot,
  saveJsonSnapshot,
};

// ============================================================================
// Raw SQL Execution
// ============================================================================

/**
 * Execute a raw SQL query with automatic retry logic.
 * Use this for queries that cannot be expressed through the Drizzle ORM.
 *
 * @param query - SQL query built using drizzle-orm's sql template tag
 * @returns Query result
 *
 * @example
 * ```ts
 * import { sql } from 'drizzle-orm';
 * const result = await executeRaw(sql`SELECT * FROM users WHERE id = ${userId}`);
 * ```
 */
export async function executeRaw<T = unknown>(
  query: ReturnType<typeof sql>,
): Promise<T> {
  if (currentStorageMode !== "postgres") {
    throw new Error("executeRaw is only supported in PostgreSQL mode");
  }

  const drizzleInstance = getDrizzleInstance();
  if (!drizzleInstance) {
    throw new Error(
      "Database not initialized. Check DATABASE_URL or use initializeJsonMode().",
    );
  }

  return withRetryInternal(async () => {
    const result = await drizzleInstance.execute(query);
    return result as T;
  });
}

// ============================================================================
// Main Exports
// ============================================================================

/**
 * Read-only methods that can safely use read replica
 */
const READ_METHODS = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "query",
  "findUnique",
  "findFirst",
  "findMany",
  "count",
  "aggregate",
  "$queryRaw",
]);

/**
 * Read-only methods on table repositories (e.g. db.user.findMany)
 */
const TABLE_READ_METHODS = new Set([
  "findUnique",
  "findFirst",
  "findMany",
  "count",
  "aggregate",
]);

/**
 * Write methods that must use primary database.
 * Used in createModeAwareDbProxy to distinguish write operations from read operations
 * for proper routing (writes always go to primary, reads can use replica).
 */
const WRITE_METHODS = new Set([
  "insert",
  "update",
  "delete",
  "execute",
  "transaction",
  "$transaction",
  "$executeRaw",
  "create",
  "createMany",
  "updateMany",
  "deleteMany",
  "upsert",
]);

/**
 * Create a lazy proxy that switches between PostgreSQL and JSON mode,
 * and automatically routes reads to replica when available.
 */
function createModeAwareDbProxy(): DrizzleClient {
  const tableProxyCache = new Map<string | symbol, object>();
  const boundMethodCachePerTable = new Map<
    string | symbol,
    Map<PropertyKey, unknown>
  >();
  const TABLE_PROXY_CACHE_MAX = 100;
  const BOUND_METHOD_CACHE_MAX = 50;
  let cachedReplicaVersion = getReadReplicaDbVersion();
  let cachedPrimaryVersion = getPrimaryDbVersion();

  const handler: ProxyHandler<DrizzleClient> = {
    get(_target, prop: string | symbol) {
      if (
        cachedReplicaVersion !== getReadReplicaDbVersion() ||
        cachedPrimaryVersion !== getPrimaryDbVersion()
      ) {
        tableProxyCache.clear();
        boundMethodCachePerTable.clear();
        cachedReplicaVersion = getReadReplicaDbVersion();
        cachedPrimaryVersion = getPrimaryDbVersion();
      }

      if (currentStorageMode !== "postgres" && jsonClient) {
        return jsonClient[prop as keyof DrizzleClient];
      }

      const propStr = String(prop);
      const isReadMethod = READ_METHODS.has(propStr);
      const isWriteMethod = WRITE_METHODS.has(propStr);
      const isClientControlMethod =
        typeof prop !== "symbol" && propStr.startsWith("$");

      if (isReadMethod) {
        const replicaClient = getReadReplicaDbClient();
        if (replicaClient) {
          return replicaClient[prop as keyof DrizzleClient];
        }
        const primaryClient = getDbClient();
        if (!primaryClient) {
          if (isBuildTime) {
            return new Proxy(
              {},
              {
                get() {
                  return () => Promise.resolve(null);
                },
              },
            );
          }
          throw new Error(
            "Database not initialized. Check DATABASE_URL or use initializeJsonMode().",
          );
        }
        return primaryClient[prop as keyof DrizzleClient];
      }

      if (!isReadMethod && !isWriteMethod && !isClientControlMethod) {
        if (tableProxyCache.has(prop)) {
          return tableProxyCache.get(prop);
        }

        if (!boundMethodCachePerTable.has(prop)) {
          boundMethodCachePerTable.set(prop, new Map<PropertyKey, unknown>());
        }
        const boundMethodCache = boundMethodCachePerTable.get(prop)!;

        const tableProxy = new Proxy({} as Record<string, never>, {
          get(_tableTarget, method: string | symbol) {
            const methodStr = String(method);

            if (TABLE_READ_METHODS.has(methodStr)) {
              if (boundMethodCache.has(method)) {
                return boundMethodCache.get(method);
              }

              const replicaClient = getReadReplicaDbClient();
              if (replicaClient) {
                const tableRepo = replicaClient[prop as keyof DrizzleClient];
                if (tableRepo && typeof tableRepo === "object") {
                  const replicaMethod = (
                    tableRepo as Record<PropertyKey, unknown>
                  )[method];
                  if (typeof replicaMethod === "function") {
                    const bound = replicaMethod.bind(tableRepo);
                    if (boundMethodCache.size >= BOUND_METHOD_CACHE_MAX) {
                      const firstKey = boundMethodCache.keys().next().value;
                      if (firstKey !== undefined)
                        boundMethodCache.delete(firstKey);
                    }
                    boundMethodCache.set(method, bound);
                    return bound;
                  }
                  return replicaMethod;
                }
              }
              const lazyClient = createLazyPrimaryClientProxy();
              const tableRepo = lazyClient[prop as keyof DrizzleClient];
              if (tableRepo && typeof tableRepo === "object") {
                const primaryMethod = (
                  tableRepo as Record<PropertyKey, unknown>
                )[method];
                if (typeof primaryMethod === "function") {
                  const bound = primaryMethod.bind(tableRepo);
                  if (boundMethodCache.size >= BOUND_METHOD_CACHE_MAX) {
                    const firstKey = boundMethodCache.keys().next().value;
                    if (firstKey !== undefined)
                      boundMethodCache.delete(firstKey);
                  }
                  boundMethodCache.set(method, bound);
                  return bound;
                }
                return primaryMethod;
              }
            }

            const client = getDbClient();
            if (!client) {
              if (isBuildTime) {
                return () => Promise.resolve(null);
              }
              throw new Error(
                "Database not initialized. Check DATABASE_URL or use initializeJsonMode().",
              );
            }

            const tableRepo = client[prop as keyof DrizzleClient];
            if (tableRepo && typeof tableRepo === "object") {
              const methodValue = (tableRepo as Record<PropertyKey, unknown>)[
                method
              ];
              if (typeof methodValue === "function") {
                return methodValue.bind(tableRepo);
              }
              return methodValue;
            }

            return tableRepo;
          },
        }) as unknown as DrizzleClient[keyof DrizzleClient];

        if (tableProxyCache.size >= TABLE_PROXY_CACHE_MAX) {
          const firstKey = tableProxyCache.keys().next().value;
          if (firstKey !== undefined) {
            tableProxyCache.delete(firstKey);
            boundMethodCachePerTable.delete(firstKey);
          }
        }
        tableProxyCache.set(prop, tableProxy);
        return tableProxy;
      }

      const client = getDbClient();
      if (!client) {
        if (isBuildTime) {
          return new Proxy(
            {},
            {
              get() {
                return () => Promise.resolve(null);
              },
            },
          );
        }
        throw new Error(
          "Database not initialized. Check DATABASE_URL or use initializeJsonMode().",
        );
      }

      return client[prop as keyof DrizzleClient];
    },
  };

  const proxyTarget: Partial<DrizzleClient> = {};
  return new Proxy(proxyTarget, handler) as DrizzleClient;
}

/**
 * Create a proxy that always routes to primary (writes).
 *
 * WHY: Provides explicit write client for cases where you want to be explicit
 * about using primary. Always uses primary database, never replica.
 *
 * NOTE: This proxy does NOT use lazy initialization - it calls getDbClient() eagerly.
 * This is intentional for backward compatibility. The main `db` proxy uses lazy
 * initialization, but `dbWrite` maintains eager behavior for existing code.
 */
function createPrimaryDbProxy(): DrizzleClient {
  const handler: ProxyHandler<DrizzleClient> = {
    get(_target, prop: string | symbol) {
      // In JSON/memory mode, use the JSON client
      // WHY: Tests use JSON mode, so we must handle it to avoid breaking tests.
      if (currentStorageMode !== "postgres" && jsonClient) {
        return jsonClient[prop as keyof DrizzleClient];
      }

      // Always use primary
      // WHY: Write operations must always go to primary database for consistency.
      // NOTE: This is eager (not lazy) for backward compatibility with existing code.
      const client = getDbClient();
      if (!client) {
        if (isBuildTime) {
          return new Proxy(
            {},
            {
              get() {
                return () => Promise.resolve(null);
              },
            },
          );
        }
        throw new Error(
          "Database not initialized. Check DATABASE_URL or use initializeJsonMode().",
        );
      }
      return client[prop as keyof DrizzleClient];
    },
  };

  const proxyTarget: Partial<DrizzleClient> = {};
  return new Proxy(proxyTarget, handler) as DrizzleClient;
}

/**
 * Create a proxy that always routes to read replica (reads)
 *
 * WHY: Provides explicit read-only client for cases where you want to be explicit
 * about using replica. Falls back to primary if no replica configured (for dev).
 *
 * NOTE: This proxy does NOT use lazy initialization - it calls getDbClient() eagerly
 * when no replica. This is intentional for backward compatibility. The main `db` proxy
 * uses lazy initialization, but `dbRead` maintains eager fallback for existing code.
 */
function createReplicaDbProxy(): DrizzleClient {
  const handler: ProxyHandler<DrizzleClient> = {
    get(_target, prop: string | symbol) {
      // In JSON/memory mode, use the JSON client
      if (currentStorageMode !== "postgres" && jsonClient) {
        return jsonClient[prop as keyof DrizzleClient];
      }

      const propStr = String(prop);
      const isReadMethod = READ_METHODS.has(propStr);
      const isWriteMethod = WRITE_METHODS.has(propStr);
      const isClientControlMethod =
        typeof prop !== "symbol" && propStr.startsWith("$");

      if (
        getReadReplicaUrl() &&
        !isReadMethod &&
        !isWriteMethod &&
        !isClientControlMethod
      ) {
        return new Proxy({} as Record<string, never>, {
          get(_tableTarget, method: string | symbol) {
            const tableRepo =
              getReadReplicaDbClient()?.[prop as keyof DrizzleClient];
            if (tableRepo && typeof tableRepo === "object") {
              const methodValue = (tableRepo as Record<PropertyKey, unknown>)[
                method
              ];
              if (typeof methodValue === "function") {
                return methodValue.bind(tableRepo);
              }
              return methodValue;
            }
            throw new Error(
              "Database not initialized. Check DATABASE_URL or use initializeJsonMode().",
            );
          },
        }) as unknown as DrizzleClient[keyof DrizzleClient];
      }

      const replicaClient = getReadReplicaDbClient();
      if (replicaClient) {
        return replicaClient[prop as keyof DrizzleClient];
      }

      // Fallback to primary if no replica
      // WHY: Dev environments typically have only one DB, so fallback is needed.
      // NOTE: This is eager (not lazy) for backward compatibility with existing code.
      // The main `db` proxy uses lazy initialization, but `dbRead` keeps eager fallback.
      const client = getDbClient();
      if (!client) {
        if (isBuildTime) {
          return new Proxy(
            {},
            {
              get() {
                return () => Promise.resolve(null);
              },
            },
          );
        }
        throw new Error(
          "Database not initialized. Check DATABASE_URL or use initializeJsonMode().",
        );
      }
      return client[prop as keyof DrizzleClient];
    },
  };

  const proxyTarget: Partial<DrizzleClient> = {};
  return new Proxy(proxyTarget, handler) as DrizzleClient;
}

/**
 * Main database client with automatic read/write routing.
 *
 * **Lazy Connection Creation**: Client objects are only created when queries execute,
 * not during property access. This optimizes cold start performance.
 *
 * **HOW IT WORKS**:
 * - Property access (e.g., `db.user`) returns a lazy proxy (no client creation)
 * - Method access (e.g., `db.user.findMany`) triggers client creation
 * - Method invocation (e.g., `db.user.findMany()`) executes query with client
 *
 * **WHY LAZY**:
 * - Faster cold starts: No connection pool initialization until needed
 * - Lower memory: No client objects created for routes that don't execute queries
 * - Better for serverless: Fewer objects created per request
 * - With replica: Reads never create write client objects
 *
 * **Routing Behavior**:
 * - Reads (select, findMany, findUnique, count, etc.) → read replica (if configured)
 * - Writes (insert, update, delete, create, etc.) → primary database
 * - Falls back to primary if no replica is configured (lazy - client only created on query execution)
 *
 * **WHY FALLBACK**: Dev environments typically have only one database. The fallback
 * ensures reads still work, but client creation is lazy (only when query executes).
 *
 * @example
 * ```typescript
 * // Property access - no client created (lazy)
 * const userRepo = db.user;
 *
 * // Method access - client created now (lazy proxy triggers getDbClient())
 * const findManyMethod = db.user.findMany;
 *
 * // Method invocation - query executes with client
 * const posts = await db.post.findMany({ take: 100 });
 *
 * // Write operation - uses primary (lazy - client created on query execution)
 * await db.post.create({ data: { ... } });
 * ```
 */
export const db: DrizzleClient = createModeAwareDbProxy();

/**
 * Explicit read-only client that always routes to read replica.
 * Falls back to primary if no replica is configured.
 *
 * **WHY THIS EXISTS**: Provides explicit read-only client for cases where you want
 * to be explicit about using replica. Useful for feed queries, search results,
 * analytics queries, and public data that can tolerate slight replication lag.
 *
 * **LAZY BEHAVIOR**: When replica is configured, uses lazy proxy (client created on query).
 * When no replica, falls back to primary eagerly (for backward compatibility).
 *
 * **WHY EAGER FALLBACK**: Maintains backward compatibility with existing code that
 * relies on `dbRead` fallback. The main `db` proxy uses lazy initialization, but
 * `dbRead` keeps eager fallback to avoid breaking existing code.
 *
 * **NOTE**: If you want lazy behavior without replica, use `db` instead of `dbRead`.
 * The `db` proxy uses lazy initialization even when falling back to primary.
 *
 * @example
 * ```typescript
 * // Uses replica if configured (lazy - client created on query)
 * const posts = await dbRead.post.findMany({ take: 100 });
 *
 * // Falls back to primary if no replica (eager - for backward compatibility)
 * const user = await dbRead.user.findUnique({ where: { id: userId } });
 * ```
 */
export const dbRead: DrizzleClient = createReplicaDbProxy();

/**
 * Explicit write-only client that always routes to primary database.
 *
 * **WHY THIS EXISTS**: Provides explicit write client for cases requiring strong consistency
 * or when you want to be explicit about using primary. Always uses primary database.
 *
 * **LAZY BEHAVIOR**: Client is created lazily (only when query executes), not on property access.
 * This is consistent with the main `db` proxy's lazy behavior.
 *
 * **USE CASES**:
 * - Write operations (creates, updates, deletes)
 * - Operations requiring strong consistency
 * - Read-after-write consistency (read immediately after write to ensure fresh data)
 * - Transactions
 *
 * **WHY READ-AFTER-WRITE**: After writing to primary, reading from replica might return
 * stale data due to replication lag. Use `dbWrite` for both write and subsequent read
 * to ensure you get the data you just wrote.
 *
 * @example
 * ```typescript
 * // Write operation (lazy - client created on query execution)
 * await dbWrite.post.create({ data: { ... } });
 *
 * // Read-after-write (ensures consistency - uses primary for both)
 * await dbWrite.user.update({ where: { id }, data: { ... } });
 * const user = await dbWrite.user.findUnique({ where: { id } }); // ✅ Fresh data
 * ```
 */
export const dbWrite: DrizzleClient = createPrimaryDbProxy();

/** Raw Drizzle instance for advanced queries (PostgreSQL only) */
export function getRawDrizzle(): Database {
  if (currentStorageMode !== "postgres") {
    throw new Error("getRawDrizzle() is only available in PostgreSQL mode");
  }
  const instance = getDrizzleInstance();
  if (!instance) throw new Error("Database not initialized");
  return instance;
}

/** Execute within a transaction */
export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const instance = getDrizzleInstance();
  if (!instance) throw new Error("Database not initialized");
  return withRetryInternal(() => instance.transaction(fn));
}

// ============================================================================
// RLS Context Support
// ============================================================================

/** User identifier - can be a string ID or an object with userId property */
export type UserIdOrUser = string | { userId: string };

/**
 * Execute as a specific user (with RLS)
 * @param userIdOrUser - A string userId or an object with userId property (e.g., AuthenticatedUser)
 * @param operation - The database operation to execute
 */
export async function asUser<T>(
  userIdOrUser: UserIdOrUser,
  operation: (database: DrizzleClient) => Promise<T>,
): Promise<T> {
  // Extract userId from string or object
  const userId =
    typeof userIdOrUser === "string" ? userIdOrUser : userIdOrUser.userId;

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const privyDidRegex = /^did:privy:[a-z0-9]+$/i;
  const snowflakeRegex = /^\d{15,20}$/;

  if (
    !uuidRegex.test(userId) &&
    !privyDidRegex.test(userId) &&
    !snowflakeRegex.test(userId)
  ) {
    throw new Error(`Invalid userId format: ${userId}`);
  }

  const instance = getDrizzleInstance();
  if (!instance) throw new Error("Database not initialized");

  return withRetryInternal(() =>
    instance.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_user_id', ${userId}, true)`,
      );
      // Create a client wrapper for the transaction
      // Transaction type from Drizzle is compatible with Database
      const txClient = createDrizzleClient(tx);
      return operation(txClient);
    }),
  );
}

/**
 * Execute as system (bypass RLS)
 */
export async function asSystem<T>(
  operation: (database: DrizzleClient) => Promise<T>,
  operationName?: string,
): Promise<T> {
  const startTime = Date.now();
  if (operationName) {
    logger.debug("[Drizzle] System operation", { operation: operationName });
  }

  const instance = getDrizzleInstance();
  if (!instance) throw new Error("Database not initialized");

  const result = await withRetryInternal(() =>
    instance.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.current_user_id', 'system', true)`,
      );
      // Type assertion is safe: the transaction `tx` from Drizzle implements
      // the same query/execute interface used by createDrizzleClient. The
      // operation callback only uses compatible Database methods (select,
      // insert, update, delete, execute) that both types support.
      const txClient = createDrizzleClient(tx as Database);
      return operation(txClient);
    }),
  );

  if (operationName) {
    logger.debug("[Drizzle] System operation completed", {
      operation: operationName,
      duration: `${Date.now() - startTime}ms`,
    });
  }

  return result;
}

/**
 * Execute as public (unauthenticated)
 */
export async function asPublic<T>(
  operation: (database: DrizzleClient) => Promise<T>,
): Promise<T> {
  const instance = getDrizzleInstance();
  if (!instance) throw new Error("Database not initialized");

  return withRetryInternal(() =>
    instance.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', '', true)`);
      // Transaction type is compatible with Database for our use case
      const txClient = createDrizzleClient(tx as Database);
      return operation(txClient);
    }),
  );
}

// ============================================================================
// Utilities
// ============================================================================

/** Health check */
export async function checkDatabaseHealth(): Promise<boolean> {
  const instance = getDrizzleInstance();
  if (!instance) return false;
  await instance.execute(sql`SELECT 1`);
  return true;
}

// ============================================================================
// Read Replica Support
// ============================================================================

/**
 * Execute read-only query on read replica
 *
 * @deprecated Use `dbRead` or `db` (which auto-routes reads) instead.
 * This function is redundant with the automatic routing in the main `db` client.
 *
 * @example
 * ```typescript
 * // Instead of: await onReadReplica(async (db) => db.select()...)
 * // Just use: await db.select()... (automatically routes to replica)
 * // Or explicitly: await dbRead.select()...
 * ```
 */
export async function onReadReplica<T>(
  operation: (database: Database) => Promise<T>,
): Promise<T> {
  const replica = getReadReplicaDrizzle();
  if (!replica) {
    throw new Error("Database not initialized");
  }

  return withRetryInternal(() => operation(replica));
}

/**
 * Execute read-only query on read replica using DrizzleClient (ORM-style API)
 *
 * @deprecated Use `dbRead` or `db` (which auto-routes reads) instead.
 * This function is redundant with the automatic routing in the main `db` client.
 *
 * @example
 * ```typescript
 * // Instead of: await onReadReplicaClient(async (db) => db.user.findMany(...))
 * // Just use: await db.user.findMany(...) (automatically routes to replica)
 * // Or explicitly: await dbRead.user.findMany(...)
 * ```
 */
export async function onReadReplicaClient<T>(
  operation: (database: DrizzleClient) => Promise<T>,
): Promise<T> {
  const replicaClient = getReadReplicaDbClient();
  if (!replicaClient) {
    throw new Error("Database not initialized");
  }

  return withRetryInternal(() => operation(replicaClient));
}

/**
 * Check if a read replica is configured and available
 */
export function isReadReplicaAvailable(): boolean {
  return !!getReadReplicaUrl();
}

/** Graceful shutdown */
export async function closeDatabase(): Promise<void> {
  // Close read replica first
  if (globalForDb.readReplicaClient) {
    await globalForDb.readReplicaClient.end();
    globalForDb.readReplicaClient = undefined;
    logger.info("[Drizzle] Read replica connection closed");
  }

  if (globalForDb.readReplicaDrizzle || globalForDb.readReplicaDb) {
    globalForDb.readReplicaDrizzle = undefined;
    globalForDb.readReplicaDb = undefined;
    bumpReadReplicaDbVersion();
  }

  // Close primary connection
  if (globalForDb.postgresClient) {
    await globalForDb.postgresClient.end();
    globalForDb.postgresClient = undefined;
    globalForDb.drizzleDb = undefined;
    globalForDb.db = undefined;
    bumpPrimaryDbVersion();
    logger.info("[Drizzle] Database connections closed");
  }
}

export function getDatabaseClientState() {
  return {
    hasPrimaryClient: globalForDb.postgresClient !== undefined,
    hasPrimaryDrizzle: globalForDb.drizzleDb !== undefined,
    hasPrimaryProxy: globalForDb.db !== undefined,
    hasReadReplicaClient: globalForDb.readReplicaClient !== undefined,
    hasReadReplicaDrizzle: globalForDb.readReplicaDrizzle !== undefined,
    hasReadReplicaProxy: globalForDb.readReplicaDb !== undefined,
  };
}
