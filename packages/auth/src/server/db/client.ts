/** PostgreSQL and embedded PGlite ownership, tenant context and query deadlines. */
import { AsyncLocalStorage } from "node:async_hooks";
import { ElizaError, logger } from "@elizaos/core";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireLoginValue } from "../../required";
import type { PGLiteDb } from "./pglite";

import * as schema from "./schema";
import * as schemaAuth from "./schema-auth";

declare const process: {
  env: Record<string, string | undefined>;
};

export type DatabaseDriver = "postgres-js";

const FULL_SCHEMA = { ...schema, ...schemaAuth };

export function getDatabaseDriver(): DatabaseDriver {
  const raw = process.env.DATABASE_DRIVER?.trim().toLowerCase();
  if (raw && raw !== "postgres-js") {
    throw new ElizaError("Login supports postgres-js or embedded PGlite", {
      code: "LOGIN_DATABASE_DRIVER_UNSUPPORTED",
      context: { driver: raw },
    });
  }
  return "postgres-js";
}

export function getDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  assertDatabaseUrlTls(connectionString);
  return connectionString;
}

/**
 * Refuse to start in production if DATABASE_URL is not using authenticated TLS.
 * Localhost connections are exempt. STEWARD_ALLOW_INSECURE_DB=true is a separate
 * acknowledgement for intentionally plaintext private-network deployments.
 *
 * SEC-087: postgres-js treats `sslmode=require` as TLS WITHOUT server certificate
 * verification — the connection is encrypted but MITM-able on a hostile network.
 * Only `verify-ca` / `verify-full` (with `sslrootcert`) authenticate the peer.
 * `require` is accepted only with STEWARD_ALLOW_UNVERIFIED_DB_TLS=true, which
 * deliberately acknowledges encryption without peer authentication.
 */
type DatabaseSecurityEnv = {
  NODE_ENV?: string;
  STEWARD_ALLOW_INSECURE_DB?: string;
  STEWARD_ALLOW_UNVERIFIED_DB_TLS?: string;
};

function databaseTlsRequiredError(
  message: string,
): Error & { code: "DB_TLS_REQUIRED" } {
  const error = new Error(message) as Error & { code: "DB_TLS_REQUIRED" };
  error.code = "DB_TLS_REQUIRED";
  return error;
}

export function assertDatabaseUrlTls(
  connectionString: string,
  securityEnv: DatabaseSecurityEnv = process.env,
): void {
  if (securityEnv.NODE_ENV !== "production") return;

  const allowInsecure = securityEnv.STEWARD_ALLOW_INSECURE_DB === "true";
  const allowUnverifiedTls =
    securityEnv.STEWARD_ALLOW_UNVERIFIED_DB_TLS === "true";
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    if (allowInsecure) {
      logger.warn(
        {
          details: [
            "[db] WARNING: STEWARD_ALLOW_INSECURE_DB=true — DATABASE_URL is not a valid URL, so TLS cannot be verified.",
          ],
        },
        "[Login:client] warn",
      );
      return;
    }
    throw new Error(
      "DATABASE_URL must be a valid URL so TLS settings can be verified in production",
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      "DATABASE_URL must use the postgres:// or postgresql:// scheme",
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;

  // Parse the query parameter instead of substring-matching the raw URL. A
  // password/path such as `.../sslmode=require` must not satisfy the check,
  // and duplicate sslmode parameters are ambiguous across client parsers.
  const sslModes = parsed.searchParams
    .getAll("sslmode")
    .map((value) => value.toLowerCase());
  const hasTls =
    sslModes.length === 1 &&
    ["require", "verify-ca", "verify-full"].includes(sslModes[0]);
  if (hasTls) {
    if (sslModes[0] === "require") {
      if (!allowUnverifiedTls) {
        throw new Error(
          "DATABASE_URL sslmode=require does not authenticate the database server in " +
            "production. Use sslmode=verify-full (recommended) or explicitly set " +
            "STEWARD_ALLOW_UNVERIFIED_DB_TLS=true to acknowledge this MITM risk.",
        );
      }
      logger.warn(
        {
          details: [
            "[db] WARNING: STEWARD_ALLOW_UNVERIFIED_DB_TLS=true permits sslmode=require, which " +
              "encrypts the database connection without authenticating the server. Use " +
              "sslmode=verify-full for production (SEC-087).",
          ],
        },
        "[Login:client] warn",
      );
    }
    return;
  }

  if (allowInsecure) {
    logger.warn(
      {
        details: [
          "[db] WARNING: STEWARD_ALLOW_INSECURE_DB=true — DATABASE_URL has no sslmode=require. " +
            "This is only safe on a private network. SOC2 CC6.7 requires encryption in transit.",
        ],
      },
      "[Login:client] warn",
    );
    return;
  }

  throw databaseTlsRequiredError(
    "DATABASE_URL must include sslmode=verify-full (recommended) or sslmode=verify-ca in production. " +
      "Set STEWARD_ALLOW_INSECURE_DB=true to override for private-network deployments.",
  );
}

export function createPostgresClient(connectionString = getDatabaseUrl()) {
  assertDatabaseUrlTls(connectionString);
  return postgres(connectionString, {
    max: 10,
    prepare: false,
  });
}

export const DATABASE_DEADLINE_EXCEEDED_MESSAGE =
  "database operation deadline exceeded";
const DATABASE_DEADLINE_CLEANUP_GRACE_MS = 100;

export class DatabaseDeadlineExceededError extends Error {
  constructor() {
    super(DATABASE_DEADLINE_EXCEEDED_MESSAGE);
    this.name = "DatabaseDeadlineExceededError";
  }
}

function deadlineMilliseconds(deadlineAt: number): number {
  if (!Number.isSafeInteger(deadlineAt))
    throw new Error("database deadline must be an integer");
  const remaining = deadlineAt - Date.now();
  if (remaining < 1_000) throw new DatabaseDeadlineExceededError();
  return remaining;
}

function serverDeadlineConnectionParameters(remainingMs: number) {
  // Let PostgreSQL cancel first. The driver-level timer below is the hard stop
  // for connect/acquisition stalls and retains a small window for the server's
  // cancellation response to reach the client before its socket is destroyed.
  const serverMs = Math.max(
    1,
    remainingMs - DATABASE_DEADLINE_CLEANUP_GRACE_MS,
  );
  return {
    statement_timeout: serverMs,
    lock_timeout: serverMs,
    idle_in_transaction_session_timeout: serverMs,
  };
}

function isDatabaseDeadlineError(error: unknown): boolean {
  if (error instanceof DatabaseDeadlineExceededError) return true;
  let current = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth += 1
  ) {
    const candidate = current as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    if (
      candidate.code === "57014" ||
      candidate.code === "55P03" ||
      candidate.code === "25P03" ||
      candidate.code === "CONNECT_TIMEOUT" ||
      candidate.name === "AbortError" ||
      candidate.name === "TimeoutError"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Run one database unit of work under an absolute, cancel-safe deadline.
 *
 * postgres-js uses a fresh max=1 client: there is no unbounded shared-pool
 * queue, connect_timeout covers DNS/TCP/TLS/authentication, PostgreSQL enforces
 * statement/lock/idle-in-transaction limits, and the absolute timer closes the
 * driver connection. postgres-js settles active queries only after that close,
 * so an open transaction is rolled back before this function rejects.
 *
 */
export async function withDatabaseDeadline<T>(
  deadlineAt: number,
  use: (db: ReturnType<typeof createDb>["db"]) => Promise<T>,
): Promise<T> {
  const remainingMs = deadlineMilliseconds(deadlineAt);

  if (pgliteOverride) {
    // Embedded PGLite has no network/pool and no cancel API. Keep the same
    // phase-start contract without pretending that WASM execution is abortable.
    return use(pgliteOverride.db as ReturnType<typeof createDb>["db"]);
  }

  getDatabaseDriver();

  const client = postgres(getDatabaseUrl(), {
    max: 1,
    prepare: false,
    connect_timeout: Math.max(1, Math.floor(remainingMs / 1_000)),
    connection: serverDeadlineConnectionParameters(remainingMs),
  });
  const db = drizzlePostgres(client, { schema: FULL_SCHEMA });
  let deadlineClose: Promise<void> | undefined;
  const timer = setTimeout(() => {
    // This is driver cancellation, not an abandoned Promise.race. Destroying
    // the sole connection makes PostgreSQL roll back any open transaction and
    // rejects its query before `use` can settle.
    deadlineClose = client.end({ timeout: 0 });
  }, remainingMs);
  try {
    return await use(db);
  } catch (error) {
    if (
      deadlineClose ||
      Date.now() >= deadlineAt ||
      isDatabaseDeadlineError(error)
    ) {
      if (deadlineClose) await deadlineClose.catch(() => undefined);
      throw new DatabaseDeadlineExceededError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (deadlineClose) await deadlineClose.catch(() => undefined);
    else await client.end({ timeout: 0 });
  }
}

// ─── postgres-js (Bun/Node) ───────────────────────────────────────────────────

export function createDb(connectionString = getDatabaseUrl()) {
  const client = createPostgresClient(connectionString);
  const db = drizzlePostgres(client, { schema: FULL_SCHEMA });

  return { client, db };
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

/** Reports whether the process owns the single-connection embedded database. */
export function isEmbeddedDatabase(): boolean {
  return pgliteOverride !== undefined;
}

// ─── Request-scoped database propagation ────────────────────────────────────

type RequestDatabase = Omit<ReturnType<typeof createDb>["db"], "$client">;
interface RequestDatabaseContext {
  sourceDb: RequestDatabase;
  db: RequestDatabase | undefined;
  active: boolean;
  tenantId?: string;
  userId?: string;
  isolationLevel?: "repeatable read";
  readOnly?: boolean;
  pendingTasks: Set<Promise<unknown>>;
  guardedObjects: WeakMap<object, object>;
}
const tenantTransactionDatabaseStorage =
  new AsyncLocalStorage<RequestDatabaseContext>();

export function hasTenantTransactionDatabase(expected?: {
  tenantId: string;
  userId?: string;
  db?: RequestDatabase;
  isolationLevel?: "repeatable read";
  readOnly?: boolean;
}): boolean {
  const context = tenantTransactionDatabaseStorage.getStore();
  if (!context?.active || !context.db) return false;
  if (
    expected &&
    (context.tenantId !== expected.tenantId ||
      (expected.userId !== undefined && context.userId !== expected.userId))
  ) {
    throw new Error("RLS_TENANT_DATABASE_CONTEXT_MISMATCH");
  }
  if (
    expected &&
    ((expected.isolationLevel !== undefined &&
      context.isolationLevel !== expected.isolationLevel) ||
      (expected.readOnly !== undefined &&
        context.readOnly !== expected.readOnly))
  ) {
    throw new Error("RLS_TENANT_DATABASE_CHARACTERISTICS_MISMATCH");
  }
  if (expected?.db !== undefined && expected.db !== context.db) return false;
  return true;
}

function assertRequestDatabaseContextActive(
  context: RequestDatabaseContext,
): asserts context is RequestDatabaseContext & { db: RequestDatabase } {
  if (!context.active) throw new Error("REQUEST_DATABASE_CONTEXT_CLOSED");
  if (!context.db) throw new Error("REQUEST_DATABASE_CONTEXT_INVALID");
}

function trackRequestDatabaseTask<T>(
  context: RequestDatabaseContext,
  task: Promise<T>,
): Promise<T> {
  assertRequestDatabaseContextActive(context);
  const tracked = task as Promise<unknown>;
  context.pendingTasks.add(tracked);
  void tracked.then(
    () => context.pendingTasks.delete(tracked),
    () => context.pendingTasks.delete(tracked),
  );
  return task;
}

const REQUEST_DATABASE_CAPABILITY_METHODS = [
  "batch",
  "close",
  "connect",
  "copyFrom",
  "copyTo",
  "cursor",
  "end",
  "execute",
  "listen",
  "prepare",
  "query",
  "release",
  "stream",
  "transaction",
  "unlisten",
  "unsubscribe",
] as const;

/**
 * Promise results are normally inert query data and must remain usable after
 * the request closes. A driver can also resolve a live transport capability,
 * though: PGLite `listen()` resolves an unsubscribe callable and pool
 * `connect()` methods resolve clients. Identify those callable/client-like
 * results without turning ordinary row arrays and objects into revoked
 * proxies.
 */
function isRequestDatabaseCapabilityResult(value: unknown): value is object {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;

  try {
    let cursor: object | null = value;
    while (cursor) {
      for (const property of REQUEST_DATABASE_CAPABILITY_METHODS) {
        const descriptor = Reflect.getOwnPropertyDescriptor(cursor, property);
        if (!descriptor) continue;
        if ("value" in descriptor) {
          if (typeof descriptor.value === "function") return true;
        } else if (descriptor.get || descriptor.set) {
          // Do not invoke an unknown transport accessor merely to classify it.
          return true;
        }
      }
      cursor = Reflect.getPrototypeOf(cursor);
    }
  } catch {
    // Driver objects are trusted, but reflection failure must not turn an
    // opaque result into an unguarded request-owned capability.
    return true;
  }
  return false;
}

/** Keep registered database work inside the tenant transaction that authorized it. */
export function waitUntilTenantDatabaseTask<T>(
  task: () => Promise<T>,
): Promise<T> {
  const context = tenantTransactionDatabaseStorage.getStore();
  if (!context) return task();
  assertRequestDatabaseContextActive(context);
  return trackRequestDatabaseTask(context, task());
}

/**
 * Bind a transaction as the only database capability visible to downstream
 * services. Existing route code can continue resolving `getDb()`, but every
 * query is pinned to the same transaction carrying the tenant-local GUC.
 * Detached registered work is drained before the transaction callback returns;
 * retained handles are revoked at the boundary.
 */
export async function withTenantTransactionDatabase<T>(
  transactionDb: RequestDatabase,
  identity: { tenantId: string; userId?: string },
  callback: () => Promise<T>,
  characteristics?: { isolationLevel?: "repeatable read"; readOnly?: boolean },
): Promise<T> {
  if (tenantTransactionDatabaseStorage.getStore()) {
    throw new Error("RLS_TENANT_DATABASE_CONTEXT_NESTED");
  }
  const context: RequestDatabaseContext = {
    sourceDb: transactionDb,
    db: undefined,
    active: true,
    tenantId: identity.tenantId,
    userId: identity.userId,
    isolationLevel: characteristics?.isolationLevel,
    readOnly: characteristics?.readOnly,
    pendingTasks: new Set(),
    guardedObjects: new WeakMap(),
  };
  context.db = guardRequestDatabaseValue(transactionDb, context);
  try {
    return await tenantTransactionDatabaseStorage.run(context, async () => {
      const result = await callback();
      await drainRequestDatabaseTasks(context);
      return result;
    });
  } finally {
    context.active = false;
    context.db = undefined;
  }
}

/**
 * Build a revocable membrane around a request-owned Drizzle handle.
 *
 * Revoking only AsyncLocalStorage is insufficient: a detached closure can call
 * getDb() while the request is active, retain the returned handle (or a query
 * builder/method derived from it), and use that retained capability after the
 * Worker closes its pool. Every property access and invocation through this
 * membrane re-checks the owner lease. Promise-returning driver operations are
 * also tracked so an operation started during the request is drained before
 * the transport is released.
 */
function guardRequestDatabaseValue<T>(
  value: T,
  context: RequestDatabaseContext,
): T {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  )
    return value;

  const guardPromiseFulfillment = <R>(result: R): R =>
    isRequestDatabaseCapabilityResult(result)
      ? guardRequestDatabaseValue(result, context)
      : result;

  const objectValue = value as object;
  const existing = context.guardedObjects.get(objectValue);
  if (existing) return existing as T;
  if (value instanceof Promise) {
    const guardedPromise = value.then(
      (result) => guardPromiseFulfillment(result),
      (error) => {
        throw guardPromiseFulfillment(error);
      },
    );
    context.guardedObjects.set(objectValue, guardedPromise);
    context.guardedObjects.set(guardedPromise, guardedPromise);
    return trackRequestDatabaseTask(context, guardedPromise) as T;
  }

  const guardCallback = (callback: (...args: unknown[]) => unknown) => {
    return function guardedDatabaseCallback(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      assertRequestDatabaseContextActive(context);
      const guardedThis = guardRequestDatabaseValue(this, context);
      const guardedArgs = args.map((argument) =>
        guardRequestDatabaseValue(argument, context),
      );
      const result = Reflect.apply(callback, guardedThis, guardedArgs);
      return guardRequestDatabaseValue(result, context);
    };
  };

  const guardCallbackArguments = (args: unknown[]): unknown[] =>
    args.map((argument) =>
      typeof argument === "function"
        ? guardCallback(argument as (...callbackArgs: unknown[]) => unknown)
        : argument,
    );

  const guardPromiseContinuation = (
    callback: (...args: unknown[]) => unknown,
  ) => {
    return function guardedDatabasePromiseContinuation(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      const guardedThis = guardPromiseFulfillment(this);
      const guardedArgs = args.map(guardPromiseFulfillment);
      return Reflect.apply(callback, guardedThis, guardedArgs);
    };
  };

  const guardMember = (
    target: object,
    member: unknown,
    property?: PropertyKey,
  ): unknown => {
    if (typeof member === "function") {
      // Drizzle's cross-bundle entity check walks
      // Object.getPrototypeOf(value).constructor and then the constructor's
      // prototype chain. Preserve that identity-bearing shape inside the same
      // membrane instead of turning `constructor` into a bound method facade.
      // The callable proxy still checks this request lease on every reflection
      // and invocation, so the raw constructor never escapes.
      if (property === "constructor") {
        return guardRequestDatabaseValue(member, context);
      }
      return (...args: unknown[]) => {
        assertRequestDatabaseContextActive(context);
        // Drizzle query builders are PromiseLike. Preserve ordinary result
        // rows, but membrane callable/client-like fulfillment values supplied
        // by either a driver thenable or a native assimilation continuation.
        const guardedArgs =
          property === "then"
            ? args.map((argument) =>
                typeof argument === "function"
                  ? guardPromiseContinuation(
                      argument as (...callbackArgs: unknown[]) => unknown,
                    )
                  : argument,
              )
            : guardCallbackArguments(args);
        const result = Reflect.apply(member, target, guardedArgs);
        return guardRequestDatabaseValue(result, context);
      };
    }
    return guardRequestDatabaseValue(member, context);
  };

  const guarded = new Proxy(objectValue, {
    get(target, property) {
      assertRequestDatabaseContextActive(context);
      const member = Reflect.get(target, property, target);
      return guardMember(target, member, property);
    },
    set() {
      assertRequestDatabaseContextActive(context);
      throw new Error("REQUEST_DATABASE_REFLECTION_UNAVAILABLE");
    },
    has(target, property) {
      assertRequestDatabaseContextActive(context);
      return Reflect.has(target, property);
    },
    defineProperty() {
      assertRequestDatabaseContextActive(context);
      throw new Error("REQUEST_DATABASE_REFLECTION_UNAVAILABLE");
    },
    deleteProperty() {
      assertRequestDatabaseContextActive(context);
      throw new Error("REQUEST_DATABASE_REFLECTION_UNAVAILABLE");
    },
    getOwnPropertyDescriptor(target, property) {
      assertRequestDatabaseContextActive(context);
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (!descriptor) return undefined;
      if (!descriptor.configurable) {
        throw new Error("REQUEST_DATABASE_REFLECTION_UNAVAILABLE");
      }
      if ("value" in descriptor) {
        return {
          ...descriptor,
          value: guardMember(target, descriptor.value, property),
        };
      }
      return {
        ...descriptor,
        get: descriptor.get
          ? () => {
              assertRequestDatabaseContextActive(context);
              return guardRequestDatabaseValue(
                Reflect.apply(
                  requireLoginValue(descriptor.get, "descriptor.get"),
                  target,
                  [],
                ),
                context,
              );
            }
          : undefined,
        set: descriptor.set
          ? () => {
              assertRequestDatabaseContextActive(context);
              throw new Error("REQUEST_DATABASE_REFLECTION_UNAVAILABLE");
            }
          : undefined,
      };
    },
    getPrototypeOf(target) {
      assertRequestDatabaseContextActive(context);
      // Drizzle uses prototype inspection to recognize aliased subqueries and
      // columns during composition. Return a recursively guarded prototype so
      // those checks keep working without exposing a raw object or callable.
      // Proxy invariants require the exact raw prototype for non-extensible
      // targets; refusing that uncommon case is safer than leaking it.
      if (!Reflect.isExtensible(target)) {
        throw new Error("REQUEST_DATABASE_REFLECTION_UNAVAILABLE");
      }
      const prototype = Reflect.getPrototypeOf(target);
      return prototype === null
        ? null
        : guardRequestDatabaseValue(prototype, context);
    },
    setPrototypeOf() {
      assertRequestDatabaseContextActive(context);
      throw new Error("REQUEST_DATABASE_REFLECTION_UNAVAILABLE");
    },
    isExtensible(target) {
      assertRequestDatabaseContextActive(context);
      return Reflect.isExtensible(target);
    },
    preventExtensions() {
      assertRequestDatabaseContextActive(context);
      throw new Error("REQUEST_DATABASE_REFLECTION_UNAVAILABLE");
    },
    ownKeys(target) {
      assertRequestDatabaseContextActive(context);
      return Reflect.ownKeys(target);
    },
    apply(target, thisArg, args) {
      assertRequestDatabaseContextActive(context);
      const result = Reflect.apply(
        target as unknown as (...callArgs: unknown[]) => unknown,
        thisArg,
        guardCallbackArguments(args),
      );
      return guardRequestDatabaseValue(result, context);
    },
    construct(target, args) {
      assertRequestDatabaseContextActive(context);
      const result = Reflect.construct(
        target as unknown as new (
          ...args: unknown[]
        ) => object,
        guardCallbackArguments(args),
      );
      return guardRequestDatabaseValue(result, context);
    },
  });
  context.guardedObjects.set(objectValue, guarded);
  context.guardedObjects.set(guarded, guarded);
  return guarded as T;
}

async function drainRequestDatabaseTasks(
  context: RequestDatabaseContext,
): Promise<void> {
  // A registered task may enqueue another registered task before it settles.
  // Keep the owner lease active until the set reaches a stable empty state.
  while (context.pendingTasks.size > 0) {
    await Promise.allSettled([...context.pendingTasks]);
  }
}

// ─── Global singleton ─────────────────────────────────────────────────────────

let globalDb: ReturnType<typeof createDb> | undefined;

function buildGlobalDb() {
  getDatabaseDriver();
  return createDb();
}

export function getDb() {
  const tenantContext = tenantTransactionDatabaseStorage.getStore();
  if (tenantContext) {
    assertRequestDatabaseContextActive(tenantContext);
    return tenantContext.db;
  }
  if (pgliteOverride)
    return pgliteOverride.db as ReturnType<typeof createDb>["db"];
  globalDb ??= buildGlobalDb();
  return globalDb.db;
}

/**
 * Returns the pooled PostgreSQL client for raw transactional auth-store queries.
 * Request-scoped databases and embedded transactions use their own adapters;
 */
export function getSql() {
  const tenantContext = tenantTransactionDatabaseStorage.getStore();
  if (tenantContext) {
    if (!tenantContext.active)
      throw new Error("REQUEST_DATABASE_CONTEXT_CLOSED");
    throw new Error(
      "RLS_TENANT_RAW_SQL_UNAVAILABLE: use the tenant transaction database",
    );
  }
  if (pgliteOverride) {
    throw new Error(
      "getSql() is not available in PGLite mode — use getDb() instead",
    );
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

  await globalDb.client.end();

  globalDb = undefined;
}

export type Database = ReturnType<typeof getDb>;
