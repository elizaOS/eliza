/**
 * Pluggable backend implementations for ChallengeStore and TokenStore.
 *
 * All backends implement StoreBackend: a simple async key-value interface
 * with per-entry TTL semantics.
 *
 * Hierarchy (best → fallback):
 *   Redis  →  Postgres  →  Memory
 *
 * The caller (typically packages/api/src/routes/auth.ts) picks the best
 * available backend and passes it to ChallengeStore / TokenStore via their
 * constructors.  Neither store cares which backend it uses.
 */

import { getSql } from "@stwd/db";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface StoreBackend {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

// ─── In-memory backend ─────────────────────────────────────────────────────

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

/**
 * Simple in-memory backend with automatic TTL expiry.
 * This is the zero-config default — no external dependencies required.
 */
export class MemoryBackend implements StoreBackend {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(cleanupIntervalMs = 60_000) {
    this.cleanupTimer = setInterval(() => this._cleanup(), cleanupIntervalMs);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  private _cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ─── Redis backend ─────────────────────────────────────────────────────────

/**
 * Minimal duck-typed Redis interface — any ioredis.Redis instance satisfies this.
 * Keeping it narrow means @stwd/auth doesn't need ioredis as a direct dependency.
 */
export interface RedisLike {
  set(key: string, value: string, expiryMode: "PX", time: number): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Redis-backed store backend.
 * Uses atomic SET key value PX ttlMs for writes; native TTL handles expiry.
 *
 * Pass a connected ioredis client (e.g. from packages/redis `getRedis()`).
 */
export class RedisBackend implements StoreBackend {
  constructor(
    private readonly client: RedisLike,
    private readonly prefix = "auth:",
  ) {}

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.client.set(this.prefix + key, value, "PX", ttlMs);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.prefix + key);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }
}

// ─── Postgres backend ─────────────────────────────────────────────────────────

/**
 * Postgres-backed store using a simple key-value table with a TTL column.
 *
 * Table: auth_kv_store (id TEXT, namespace TEXT, value TEXT, expires_at TIMESTAMPTZ)
 * The table is created automatically on first use (CREATE TABLE IF NOT EXISTS),
 * so no manual migration is strictly required — but the numbered SQL migration
 * in packages/db/drizzle/ is preferred for production deployments.
 *
 * Uses the postgres-js client (getSql()) for raw parameterised queries so that
 * this package does not need a direct drizzle-orm dependency.
 *
 * Expired rows are cleaned up lazily on read.
 */
export class PostgresBackend implements StoreBackend {
  private initialized = false;

  /**
   * @param namespace  Logical partition (e.g. "challenge", "token") so multiple
   *                   stores can share the same table without key collision.
   */
  constructor(private readonly namespace: string) {}

  private getSqlClient() {
    return getSql();
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    const sql = this.getSqlClient();
    await sql`
      CREATE TABLE IF NOT EXISTS auth_kv_store (
        id          TEXT        NOT NULL,
        namespace   TEXT        NOT NULL,
        value       TEXT        NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (id, namespace)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS auth_kv_store_expires_idx
        ON auth_kv_store (expires_at)
    `;
    this.initialized = true;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.ensureTable();
    const sql = this.getSqlClient();
    const expiresAt = new Date(Date.now() + ttlMs);
    await sql`
      INSERT INTO auth_kv_store (id, namespace, value, expires_at)
      VALUES (${key}, ${this.namespace}, ${value}, ${expiresAt})
      ON CONFLICT (id, namespace) DO UPDATE
        SET value      = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at
    `;
  }

  async get(key: string): Promise<string | null> {
    await this.ensureTable();
    const sql = this.getSqlClient();
    const rows = await sql<Array<{ value: string }>>`
      SELECT value
        FROM auth_kv_store
       WHERE id        = ${key}
         AND namespace = ${this.namespace}
         AND expires_at > now()
       LIMIT 1
    `;
    return rows[0]?.value ?? null;
  }

  async delete(key: string): Promise<void> {
    await this.ensureTable();
    const sql = this.getSqlClient();
    await sql`
      DELETE FROM auth_kv_store
       WHERE id        = ${key}
         AND namespace = ${this.namespace}
    `;
  }
}

// ─── Backend factory helper ───────────────────────────────────────────────────

/**
 * Build the best available backend for a given namespace.
 *
 * Priority: Redis > Postgres > Memory
 *
 * Intended to be called once at startup from API route setup code.
 * Errors are caught and logged; the function always returns a usable backend.
 *
 * @param namespace   Logical key namespace (e.g. "challenge" or "token")
 * @param redisClient An ioredis client if Redis is available, or null/undefined
 * @param usePostgres Whether the Postgres DB is considered available
 */
export async function buildBackend(
  namespace: string,
  redisClient: RedisLike | null | undefined,
  usePostgres: boolean,
): Promise<{ backend: StoreBackend; source: "redis" | "postgres" | "memory" }> {
  // 1 — try Redis
  if (redisClient) {
    try {
      const backend = new RedisBackend(redisClient, `auth:${namespace}:`);
      // Quick connectivity smoke-test
      await redisClient.set(`__ping__${namespace}`, "1", "PX", 1000);
      return { backend, source: "redis" };
    } catch (err) {
      console.warn(
        `[steward:auth] Redis backend unavailable for "${namespace}", falling back:`,
        (err as Error).message,
      );
    }
  }

  // 2 — try Postgres
  if (usePostgres) {
    try {
      const backend = new PostgresBackend(namespace);
      // Trigger table creation so we fail fast at startup
      await backend.set(`__ping__`, "1", 1000);
      await backend.delete(`__ping__`);
      return { backend, source: "postgres" };
    } catch (err) {
      console.warn(
        `[steward:auth] Postgres backend unavailable for "${namespace}", falling back to memory:`,
        (err as Error).message,
      );
    }
  }

  // 3 — in-memory fallback
  console.warn(
    `[steward:auth] Using in-memory backend for "${namespace}" — NOT suitable for multi-instance or restart-safe deployments`,
  );
  return { backend: new MemoryBackend(), source: "memory" };
}
