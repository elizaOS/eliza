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
import {
  createDrizzleClient,
  type DrizzleClient,
  type SQLValue,
} from "./client";
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
};

const isBuildTime = process.env.NEXT_PHASE === "phase-production-build";

function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test" ||
    (typeof process !== "undefined" && process.argv?.join(" ").includes("test"))
  );
}

function getConnectionUrl(): string {
  return process.env.DATABASE_URL || "postgresql://localhost:5432/polyagent";
}

function createPostgresClient(): ReturnType<typeof postgres> {
  const url = getConnectionUrl();
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

  logger.debug("[Drizzle] Creating postgres client", {
    isProd,
    isLocalhost,
    isCloudProvider,
    hasExplicitSSL,
    sslMode,
    urlHost: url.split("@")[1]?.split("/")[0] || "unknown",
  });

  return postgres(url, {
    max: isProd ? 50 : isTest ? 5 : 10,
    idle_timeout: isProd ? 30 : 20,
    connect_timeout: 10,
    ssl: sslMode,
    transform: { undefined: null },
    onnotice: () => {},
  });
}

function getPostgresClient(): ReturnType<typeof postgres> | null {
  if (isBuildTime && !isTestEnvironment()) {
    return null;
  }

  if (!globalForDb.postgresClient) {
    const url = getConnectionUrl();
    if (!url || url === "postgresql://localhost:5432/polyagent") {
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
      logger: process.env.NODE_ENV === "development",
    });
  }

  return globalForDb.drizzleDb;
}

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

      const isRetryable =
        lastError.message.includes("connection") ||
        lastError.message.includes("timeout") ||
        lastError.message.includes("deadlock") ||
        lastError.message.includes("ECONNREFUSED");

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
  await initJsonStorage("/tmp/polyagent-memory", { autoSave: false });
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
// Main Exports
// ============================================================================

/**
 * Create a lazy proxy that switches between PostgreSQL and JSON mode.
 */
function createModeAwareDbProxy(): DrizzleClient {
  const handler: ProxyHandler<DrizzleClient> = {
    get(_target, prop: string | symbol) {
      // In JSON/memory mode, use the JSON client
      if (currentStorageMode !== "postgres" && jsonClient) {
        return jsonClient[prop as keyof DrizzleClient];
      }

      // In PostgreSQL mode, use the Drizzle client
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

/** Main database instance - works with both PostgreSQL and JSON modes */
export const db: DrizzleClient = createModeAwareDbProxy();

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

/** Graceful shutdown */
export async function closeDatabase(): Promise<void> {
  if (globalForDb.postgresClient) {
    await globalForDb.postgresClient.end();
    globalForDb.postgresClient = undefined;
    globalForDb.drizzleDb = undefined;
    globalForDb.db = undefined;
    logger.info("[Drizzle] Database connections closed");
  }
}

/** Execute raw SQL */
export async function executeRaw<
  T extends Record<string, SQLValue> = Record<string, SQLValue>,
>(query: ReturnType<typeof sql>): Promise<T[]> {
  const instance = getDrizzleInstance();
  if (!instance) throw new Error("Database not initialized");
  return withRetryInternal(() => instance.execute(query)) as Promise<T[]>;
}
