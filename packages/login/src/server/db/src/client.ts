/**
 * Pluggable database client for Steward.
 *
 * Selects a driver based on the `DATABASE_DRIVER` env var:
 *   - "postgres-js"  (default)  — long-lived TCP pool via the `postgres` package.
 *                                  Used by Bun/Node entry points.
 *   - "neon-http"                — HTTP-only fetch driver via @neondatabase/serverless.
 *                                  Used by Cloudflare Workers (no TCP, no pools).
 *   - "neon-websocket"           — request-scoped Neon WebSocket pool.
 *                                  Transaction-capable Workers transport for RLS.
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

import { AsyncLocalStorage } from "node:async_hooks";
import { ElizaError } from "@elizaos/core/errors";
import { logger } from "@elizaos/logger";
import { neon, Pool } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import {
  drizzle as drizzleNeon,
  type NeonHttpDatabase,
} from "drizzle-orm/neon-http";
import {
  drizzle as drizzleNeonWebSocket,
  type NeonDatabase,
} from "drizzle-orm/neon-serverless";
import {
  drizzle as drizzlePostgres,
  type PostgresJsDatabase,
} from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireLoginValue } from "../../../required";
import type { PGLiteDb } from "./pglite";

import * as schema from "./schema";
import * as schemaAuth from "./schema-auth";

declare const process: {
  env: Record<string, string | undefined>;
};

export type DatabaseDriver = "postgres-js" | "neon-http" | "neon-websocket";

const FULL_SCHEMA = { ...schema, ...schemaAuth };
type FullSchema = typeof FULL_SCHEMA;

export function getDatabaseDriver(): DatabaseDriver {
  const raw = process.env.DATABASE_DRIVER?.trim().toLowerCase();
  if (raw === "neon-http") return "neon-http";
  if (raw === "neon-websocket") return "neon-websocket";
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

function withServerDeadlineInUrl(
  connectionString: string,
  remainingMs: number,
): string {
  const parsed = new URL(connectionString);
  const existing = parsed.searchParams.get("options")?.trim();
  const serverMs = Math.max(
    1,
    remainingMs - DATABASE_DEADLINE_CLEANUP_GRACE_MS,
  );
  const limits = [
    `-c statement_timeout=${serverMs}`,
    `-c lock_timeout=${serverMs}`,
    `-c idle_in_transaction_session_timeout=${serverMs}`,
  ].join(" ");
  parsed.searchParams.set(
    "options",
    existing ? `${existing} ${limits}` : limits,
  );
  return parsed.toString();
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
 * neon-http uses a per-call AbortSignal and the same server parameters. Its HTTP
 * response can stall independently of PostgreSQL, so the fetch abort is the hard
 * transport bound while the earlier server limit protects transaction atomicity.
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

  if (getDatabaseDriver() === "neon-http") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const { db } = createNeonHttpDb(
        withServerDeadlineInUrl(getDatabaseUrl(), remainingMs),
        {
          signal: controller.signal,
        },
      );
      return await use(db as unknown as ReturnType<typeof createDb>["db"]);
    } catch (error) {
      if (controller.signal.aborted || isDatabaseDeadlineError(error)) {
        throw new DatabaseDeadlineExceededError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

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

// ─── neon-http (Cloudflare Workers) ───────────────────────────────────────────

/**
 * Create a Drizzle instance backed by Neon's HTTP fetch driver.
 *
 * Suitable for stateless runtimes (Cloudflare Workers, edge functions).
 * Each call returns a fresh client; for per-request use this is intentional —
 * the underlying transport is HTTP, so there is no TCP connection to reuse.
 */
export function createNeonHttpDb(
  connectionString = getDatabaseUrl(),
  options: { signal?: AbortSignal } = {},
) {
  assertDatabaseUrlTls(connectionString);
  const client = neon(connectionString, {
    fetchOptions: options.signal ? { signal: options.signal } : undefined,
  });
  const db = drizzleNeon(client, { schema: FULL_SCHEMA });
  return { client, db };
}

// ─── neon-websocket (transaction-capable Workers) ───────────────────────────

export interface NeonTransactionDbHandle {
  driver: "neon-websocket";
  db: NeonDatabase<FullSchema>;
  close(): Promise<void>;
}

const NEON_TRANSACTION_DEADLINE_MS = 30_000;
const NEON_TRANSACTION_CONNECT_TIMEOUT_MS = 10_000;

interface NeonTransactionRequestEnv extends DatabaseSecurityEnv {
  DATABASE_URL?: string;
  DATABASE_DRIVER?: string;
}

interface NeonTransactionPoolConfig {
  connectionString: string;
  max: 1;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  query_timeout: number;
  statement_timeout: number;
  lock_timeout: number;
  idle_in_transaction_session_timeout: number;
}

/** @internal Exported only so security invariants can inspect the driver config without I/O. */
export function __buildNeonTransactionPoolConfigForTests(
  env: NeonTransactionRequestEnv,
): NeonTransactionPoolConfig {
  if (env.DATABASE_DRIVER?.trim().toLowerCase() !== "neon-websocket") {
    throw new Error(
      "RLS_TRANSACTION_DRIVER_REQUIRED: set DATABASE_DRIVER=neon-websocket for transaction-capable Workers database access",
    );
  }
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL binding is required for transaction-capable Workers database access",
    );
  }

  // Worker bindings, not a Node compatibility shim's process.env, are the
  // deployment authority. Cloudflare does not synthesize NODE_ENV, so fail
  // secure: a request-owned production transport is the default unless the
  // caller explicitly declares a non-production environment.
  assertDatabaseUrlTls(connectionString, {
    ...env,
    NODE_ENV: env.NODE_ENV ?? "production",
  });
  const serverMs =
    NEON_TRANSACTION_DEADLINE_MS - DATABASE_DEADLINE_CLEANUP_GRACE_MS;
  return {
    connectionString: withServerDeadlineInUrl(
      connectionString,
      NEON_TRANSACTION_DEADLINE_MS,
    ),
    max: 1,
    connectionTimeoutMillis: NEON_TRANSACTION_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: NEON_TRANSACTION_DEADLINE_MS,
    query_timeout: NEON_TRANSACTION_DEADLINE_MS,
    statement_timeout: serverMs,
    lock_timeout: serverMs,
    idle_in_transaction_session_timeout: serverMs,
  };
}

/**
 * Create one request-scoped, transaction-capable Neon database handle.
 *
 * Unlike neon-http, the WebSocket transport pins an interactive transaction
 * to one checked-out connection, so `withTenantRlsTransaction()` can safely
 * use transaction-local `set_config`. The caller MUST await `close()` after
 * every request (normally from a `finally` block before returning the
 * response). This handle is deliberately excluded from the global singleton:
 * a Worker isolate must not retain request-owned sockets after the request's
 * lifetime.
 */
export function createNeonTransactionDbForRequest(
  env: NeonTransactionRequestEnv,
): NeonTransactionDbHandle {
  const poolConfig = __buildNeonTransactionPoolConfigForTests(env);
  const pool = new Pool(poolConfig);
  const db = drizzleNeonWebSocket(pool, { schema: FULL_SCHEMA });
  let closePromise: Promise<void> | undefined;
  return {
    driver: "neon-websocket",
    db,
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
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
export function createDbForRequest(env: {
  DATABASE_URL?: string;
  DATABASE_DRIVER?: string;
}) {
  // Worker bindings are the authority for this request. Falling back to the
  // process-level selector keeps the helper compatible with Bun/Node callers,
  // but must not let an explicit WebSocket binding silently create neon-http.
  const bindingDriver = env.DATABASE_DRIVER?.trim().toLowerCase();
  if (
    bindingDriver &&
    bindingDriver !== "neon-http" &&
    bindingDriver !== "neon-websocket"
  ) {
    throw new Error(
      "DATABASE_DRIVER_UNSUPPORTED: createDbForRequest() supports neon-http only",
    );
  }
  const driver = bindingDriver || getDatabaseDriver();
  if (driver === "neon-websocket") {
    throw new Error(
      "RLS_TRANSACTION_HANDLE_REQUIRED: use createNeonTransactionDbForRequest() and await close()",
    );
  }
  const url = env.DATABASE_URL;
  if (!url)
    throw new Error(
      "DATABASE_URL binding is required for createDbForRequest()",
    );
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

/** Reports whether the process owns the single-connection embedded database. */
export function isEmbeddedDatabase(): boolean {
  return pgliteOverride !== undefined;
}

// ─── Request-scoped database propagation ────────────────────────────────────

type RequestDatabase = ReturnType<typeof createDb>["db"];
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
const requestDatabaseStorage = new AsyncLocalStorage<RequestDatabaseContext>();
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

/**
 * Apply a bounded database phase without replacing the active tenant
 * transaction or its request-owned transport. PostgreSQL timeouts are scoped
 * to the existing transaction, so the trusted tenant/user GUCs and a Worker's
 * single WebSocket connection remain authoritative for the whole phase.
 */
export async function withTenantTransactionDatabaseDeadline<T>(
  deadlineAt: number,
  use: (db: RequestDatabase) => Promise<T>,
): Promise<T> {
  const context = tenantTransactionDatabaseStorage.getStore();
  if (!context) throw new Error("RLS_TENANT_DATABASE_CONTEXT_REQUIRED");
  assertRequestDatabaseContextActive(context);
  const remainingMs = deadlineMilliseconds(deadlineAt);
  const db = context.db;
  await db.execute(sql.raw(`SET LOCAL statement_timeout = '${remainingMs}ms'`));
  await db.execute(sql.raw(`SET LOCAL lock_timeout = '${remainingMs}ms'`));
  await db.execute(
    sql.raw(
      `SET LOCAL idle_in_transaction_session_timeout = '${remainingMs}ms'`,
    ),
  );
  return use(db);
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

/**
 * Keep explicitly detached work inside the current request database lifetime.
 *
 * Worker services that intentionally start best-effort asynchronous work must
 * register the resulting promise here. The request owner drains registered
 * work before revoking the database capability and closing its socket. Outside
 * a request-owned database context this is a no-op, preserving Bun's existing
 * process-owned background-work behavior.
 */
export function waitUntilRequestDatabaseTask<T>(
  task: () => Promise<T>,
): Promise<T> {
  const context = requestDatabaseStorage.getStore();
  if (!context) return task();
  assertRequestDatabaseContextActive(context);

  const backgroundContext: RequestDatabaseContext = {
    sourceDb: context.sourceDb,
    db: undefined,
    active: true,
    pendingTasks: context.pendingTasks,
    guardedObjects: new WeakMap(),
  };
  backgroundContext.db = guardRequestDatabaseValue(
    backgroundContext.sourceDb,
    backgroundContext,
  );
  const promise = requestDatabaseStorage.run(backgroundContext, task);
  const tracked = trackRequestDatabaseTask(context, promise);
  const tenantContext = tenantTransactionDatabaseStorage.getStore();
  if (tenantContext) trackRequestDatabaseTask(tenantContext, promise);
  const revokeBackgroundContext = () => {
    backgroundContext.active = false;
    backgroundContext.db = undefined;
  };
  void promise.then(revokeBackgroundContext, revokeBackgroundContext);
  return tracked;
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
        target as unknown as Function,
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

/**
 * Bind one explicitly owned database handle to the current async request.
 *
 * Existing services resolve their database through getDb(). Keeping the
 * request handle in AsyncLocalStorage lets a Worker use its own WebSocket pool
 * without turning that pool into isolate-global mutable state. Nested bindings
 * are rejected because silently replacing an outer tenant transaction would
 * break SET LOCAL's connection and lifetime guarantees.
 */
export async function withRequestDatabase<T>(
  db: RequestDatabase,
  callback: () => Promise<T>,
  options?: { deferCleanup?: (cleanup: Promise<void>) => void },
): Promise<T> {
  if (requestDatabaseStorage.getStore()) {
    throw new Error("REQUEST_DATABASE_CONTEXT_NESTED");
  }
  const context: RequestDatabaseContext = {
    sourceDb: db,
    db: undefined,
    active: true,
    pendingTasks: new Set(),
    guardedObjects: new WeakMap(),
  };
  context.db = guardRequestDatabaseValue(db, context);
  try {
    return await requestDatabaseStorage.run(context, async () => {
      const noCallbackError = Symbol("no-request-database-callback-error");
      let callbackError: unknown | typeof noCallbackError = noCallbackError;
      let result: T | undefined;
      try {
        result = await callback();
      } catch (error) {
        callbackError = error;
      }
      // Revoke the owner immediately. Registered work runs in isolated child
      // contexts; unregistered detached work retains this closed owner context.
      context.active = false;
      context.db = undefined;
      const cleanup = drainRequestDatabaseTasks(context);
      if (options?.deferCleanup) {
        try {
          options.deferCleanup(cleanup);
        } catch (error) {
          await cleanup;
          if (callbackError === noCallbackError) throw error;
        }
      } else {
        await cleanup;
      }
      if (callbackError !== noCallbackError) throw callbackError;
      return result as T;
    });
  } finally {
    // Detached tasks inherit AsyncLocalStorage. Revoke their capability before
    // the owning Worker closes its socket so late getDb() calls fail before I/O.
    context.active = false;
    context.db = undefined;
  }
}

// ─── Global singleton ─────────────────────────────────────────────────────────

type GlobalDbHandle =
  | {
      driver: "postgres-js";
      client: ReturnType<typeof postgres>;
      db: PostgresJsDatabase<FullSchema>;
    }
  | {
      driver: "neon-http";
      client: ReturnType<typeof createNeonHttpDb>["client"];
      db: NeonHttpDatabase<FullSchema>;
    };

let globalDb: GlobalDbHandle | undefined;

function buildGlobalDb(): GlobalDbHandle {
  const driver = getDatabaseDriver();
  if (driver === "neon-websocket") {
    throw new Error(
      "RLS_TRANSACTION_HANDLE_REQUIRED: neon-websocket is request-scoped and cannot back getDb()",
    );
  }
  if (driver === "neon-http") {
    const { client, db } = createNeonHttpDb();
    return { driver: "neon-http", client, db };
  }
  const { client, db } = createDb();
  return { driver: "postgres-js", client, db };
}

export function getDb() {
  const tenantContext = tenantTransactionDatabaseStorage.getStore();
  if (tenantContext) {
    assertRequestDatabaseContextActive(tenantContext);
    return tenantContext.db;
  }
  const requestContext = requestDatabaseStorage.getStore();
  if (requestContext) {
    assertRequestDatabaseContextActive(requestContext);
    return requestContext.db;
  }
  if (pgliteOverride)
    return pgliteOverride.db as ReturnType<typeof createDb>["db"];
  globalDb ??= buildGlobalDb();
  // Both postgres-js and neon-http drivers expose the same Drizzle surface
  // for our schema; we type the public return as the postgres-js variant so
  // callers don't have to branch on driver type at every call site.
  return globalDb.db as unknown as ReturnType<typeof createDb>["db"];
}

/**
 * Returns the pooled PostgreSQL client for raw transactional auth-store queries.
 * Request-scoped databases and embedded transactions use their own adapters;
 * HTTP-only drivers cannot provide the required atomic publication contract.
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
  const requestContext = requestDatabaseStorage.getStore();
  if (requestContext) {
    if (!requestContext.active)
      throw new Error("REQUEST_DATABASE_CONTEXT_CLOSED");
    throw new Error(
      "REQUEST_DATABASE_RAW_SQL_UNAVAILABLE: use the request-scoped Drizzle database",
    );
  }
  if (pgliteOverride) {
    throw new Error(
      "getSql() is not available in PGLite mode — use getDb() instead",
    );
  }
  globalDb ??= buildGlobalDb();
  if (globalDb.driver !== "postgres-js") {
    throw new ElizaError(
      "Raw transactional SQL requires the postgres-js driver; use the request-scoped database for Neon",
      {
        code: "LOGIN_RAW_SQL_DRIVER_UNSUPPORTED",
        context: { driver: globalDb.driver },
      },
    );
  }
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
