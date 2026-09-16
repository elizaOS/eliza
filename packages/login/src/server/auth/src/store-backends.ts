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

import { logger } from "@elizaos/logger";
import { getSql, hasTenantTransactionDatabase } from "../../db/src/index.ts";
import { redactedThrownDiagnostics } from "../../shared/src/index.ts";
import { createDatabaseAuthSql, createPostgresAuthSql } from "./auth-sql";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface StorePublishEntry {
  key: string;
  /** A null value deletes the key as part of the atomic publication. */
  value: string | null;
  /** Absolute Unix epoch deadline. A value is not published after this deadline. */
  expiresAt: number;
  /**
   * Optional compare-and-publish guard. Null means the key must be absent or
   * expired. If every guard already contains its desired value, publication
   * succeeds as a no-op so a lost-ack retry cannot recreate consumed entries.
   * Otherwise every guard must still contain its expected value.
   */
  expected?: string | null;
}

function assertUniquePublishKeys(entries: readonly StorePublishEntry[]): void {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) {
      // Duplicate operations have backend-dependent last-write-wins semantics
      // and can make a guard describe a different write than the one applied.
      throw new Error("Store publication contains duplicate keys");
    }
    keys.add(entry.key);
  }
}

export interface StoreBackend {
  set(key: string, value: string, ttlMs: number): Promise<void>;
  setIfNotExists(key: string, value: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  consume(key: string): Promise<string | null>;
  /** Atomically delete only a live entry whose value exactly matches expected. */
  compareDelete(key: string, expected: string): Promise<boolean>;
  /** Atomically replace an exact value. Repeating an already-applied transition succeeds. */
  transition(
    key: string,
    expected: string,
    desired: string,
    ttlMs: number,
    guard?: { key: string; expected: string },
  ): Promise<boolean>;
  /** Atomically apply every entry, or none; returns false after any value deadline. */
  publish(entries: readonly StorePublishEntry[]): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * Adds a collision-safe logical namespace to every key sent to a shared
 * backend. This lets related stores share one durable backend selection while
 * preserving independent key spaces and atomic backend operations.
 */
export class NamespacedStoreBackend implements StoreBackend {
  private readonly keyPrefix: string;

  constructor(
    private readonly backend: StoreBackend,
    namespace: string,
  ) {
    if (namespace.length === 0)
      throw new Error("Store namespace must not be empty");
    this.keyPrefix = `${namespace.length}:${namespace}:`;
  }

  private key(key: string): string {
    return this.keyPrefix + key;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.backend.set(this.key(key), value, ttlMs);
  }

  async setIfNotExists(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    return this.backend.setIfNotExists(this.key(key), value, ttlMs);
  }

  async get(key: string): Promise<string | null> {
    return this.backend.get(this.key(key));
  }

  async consume(key: string): Promise<string | null> {
    return this.backend.consume(this.key(key));
  }

  async compareDelete(key: string, expected: string): Promise<boolean> {
    return this.backend.compareDelete(this.key(key), expected);
  }

  async transition(
    key: string,
    expected: string,
    desired: string,
    ttlMs: number,
    guard?: { key: string; expected: string },
  ): Promise<boolean> {
    return this.backend.transition(
      this.key(key),
      expected,
      desired,
      ttlMs,
      guard
        ? { key: this.key(guard.key), expected: guard.expected }
        : undefined,
    );
  }

  async publish(entries: readonly StorePublishEntry[]): Promise<boolean> {
    return this.backend.publish(
      entries.map((entry) => ({ ...entry, key: this.key(entry.key) })),
    );
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(this.key(key));
  }
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
const isWorkersRuntime =
  process.env.STEWARD_RUNTIME === "workers" ||
  (typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers");

export class MemoryBackend implements StoreBackend {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(cleanupIntervalMs = 60_000) {
    if (!isWorkersRuntime) {
      this.cleanupTimer = setInterval(() => this._cleanup(), cleanupIntervalMs);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async setIfNotExists(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    const existing = this.store.get(key);
    if (existing) {
      if (Date.now() < existing.expiresAt) return false;
      this.store.delete(key);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async consume(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    this.store.delete(key);
    if (Date.now() >= entry.expiresAt) return null;
    return entry.value;
  }

  async compareDelete(key: string, expected: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry || Date.now() >= entry.expiresAt) {
      if (entry) this.store.delete(key);
      return false;
    }
    if (entry.value !== expected) return false;
    this.store.delete(key);
    return true;
  }

  async transition(
    key: string,
    expected: string,
    desired: string,
    ttlMs: number,
    guard?: { key: string; expected: string },
  ): Promise<boolean> {
    if (guard) {
      const guarded = this.store.get(guard.key);
      if (
        !guarded ||
        Date.now() >= guarded.expiresAt ||
        guarded.value !== guard.expected
      ) {
        if (guarded && Date.now() >= guarded.expiresAt)
          this.store.delete(guard.key);
        return false;
      }
    }
    const entry = this.store.get(key);
    if (!entry || Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    if (entry.value !== expected && entry.value !== desired) return false;
    this.store.set(key, { value: desired, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async publish(entries: readonly StorePublishEntry[]): Promise<boolean> {
    assertUniquePublishKeys(entries);
    const now = Date.now();
    // Absolute SET deadlines are a commit precondition, not merely the TTL to
    // attach after publication. Reject before evaluating guards or deleting
    // prior credentials so a delayed provider acknowledgement cannot replace
    // a still-valid challenge with already-expired state.
    if (entries.some((entry) => entry.value !== null && entry.expiresAt <= now))
      return false;
    const currentValue = (key: string): string | null => {
      const current = this.store.get(key);
      if (!current || now >= current.expiresAt) return null;
      return current.value;
    };
    const guarded = entries.filter((entry) => entry.expected !== undefined);
    const states = guarded.map((entry) => {
      const current = currentValue(entry.key);
      return {
        expected: current === entry.expected,
        desired: current === entry.value,
      };
    });
    if (states.length > 0 && states.every((state) => state.desired))
      return true;
    if (states.some((state) => !state.expected)) return false;
    for (const entry of entries) {
      if (entry.value === null) this.store.delete(entry.key);
      else
        this.store.set(entry.key, {
          value: entry.value,
          expiresAt: entry.expiresAt,
        });
    }
    return true;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  private _cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now >= entry.expiresAt) this.store.delete(key);
    }
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
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
  set(
    key: string,
    value: string,
    expiryMode: "PX",
    time: number,
    condition?: "NX",
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  getdel?(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

class PublicationExpiredError extends Error {}

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

  async setIfNotExists(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    return (
      (await this.client.set(this.prefix + key, value, "PX", ttlMs, "NX")) ===
      "OK"
    );
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.prefix + key);
  }

  async consume(key: string): Promise<string | null> {
    if (this.client.getdel) {
      return this.client.getdel(this.prefix + key);
    }
    throw new Error(
      "Redis backend does not support atomic GETDEL token consumption",
    );
  }

  async compareDelete(key: string, expected: string): Promise<boolean> {
    const result = await this.client.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]); return 1 end; return 0",
      1,
      this.prefix + key,
      expected,
    );
    return result === 1 || result === "1";
  }

  async transition(
    key: string,
    expected: string,
    desired: string,
    ttlMs: number,
    guard?: { key: string; expected: string },
  ): Promise<boolean> {
    if (guard) {
      const result = await this.client.eval(
        "if redis.call('GET',KEYS[2])~=ARGV[4] then return 0 end; local v=redis.call('GET',KEYS[1]); if v==ARGV[1] or v==ARGV[2] then redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[3]); return 1 end; return 0",
        2,
        this.prefix + key,
        this.prefix + guard.key,
        expected,
        desired,
        ttlMs,
        guard.expected,
      );
      return result === 1 || result === "1";
    }
    const result = await this.client.eval(
      "local v=redis.call('GET',KEYS[1]); if v==ARGV[1] or v==ARGV[2] then redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[3]); return 1 end; return 0",
      1,
      this.prefix + key,
      expected,
      desired,
      ttlMs,
    );
    return result === 1 || result === "1";
  }

  async publish(entries: readonly StorePublishEntry[]): Promise<boolean> {
    assertUniquePublishKeys(entries);
    if (entries.length === 0) return true;
    const keys = entries.map((entry) => this.prefix + entry.key);
    const args = entries.flatMap((entry) => [
      entry.value === null ? "D" : "S",
      entry.value ?? "",
      entry.expiresAt,
      entry.expected === undefined ? "0" : entry.expected === null ? "1" : "2",
      entry.expected ?? "",
    ]);
    const result = await this.client.eval(
      "local now=redis.call('TIME'); local now_ms=tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000); local ttls={}; for i=1,#KEYS do local j=(i-1)*5; if ARGV[j+1]=='S' then local ttl=tonumber(ARGV[j+3])-now_ms; if ttl<=0 then return -1 end; ttls[i]=ttl end end; local guarded=0; local all_expected=true; local all_desired=true; for i=1,#KEYS do local j=(i-1)*5; local v=redis.call('GET',KEYS[i]); local kind=ARGV[j+4]; if kind~='0' then guarded=guarded+1; local expected=(kind=='1' and not v) or (kind=='2' and v==ARGV[j+5]); local desired=(ARGV[j+1]=='D' and not v) or (ARGV[j+1]=='S' and v==ARGV[j+2]); if not expected then all_expected=false end; if not desired then all_desired=false end end end; if guarded>0 and all_desired then return 1 end; if not all_expected then return 0 end; for i=1,#KEYS do local j=(i-1)*5; if ARGV[j+1]=='D' then redis.call('DEL',KEYS[i]) else redis.call('SET',KEYS[i],ARGV[j+2],'PX',ttls[i]) end end; return 1",
      keys.length,
      ...keys,
      ...args,
    );
    return result === 1 || result === "1";
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
let embeddedSql: ReturnType<typeof createDatabaseAuthSql> | undefined;

/** Binds durable auth state to the database owned by the embedded server. */
export function setEmbeddedAuthDatabase(enabled: boolean): void {
  embeddedSql = enabled ? createDatabaseAuthSql() : undefined;
}

export class PostgresBackend implements StoreBackend {
  private initialized = false;

  /**
   * @param namespace  Logical partition (e.g. "challenge", "token") so multiple
   *                   stores can share the same table without key collision.
   */
  constructor(
    private readonly namespace: string,
    private readonly sqlClient?:
      | ReturnType<typeof getSql>
      | ReturnType<typeof createDatabaseAuthSql>,
  ) {}

  private getSqlClient() {
    if (hasTenantTransactionDatabase()) return createDatabaseAuthSql();
    if (!this.sqlClient) return createPostgresAuthSql(getSql());
    return "unsafe" in this.sqlClient
      ? createPostgresAuthSql(this.sqlClient)
      : this.sqlClient;
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    const sql = this.getSqlClient();
    const [existing] = await sql<Array<{ relation: string | null }>>`
      SELECT to_regclass('public.auth_kv_store')::text AS relation
    `;
    if (existing?.relation) {
      this.initialized = true;
      return;
    }
    await sql.begin(async (transaction) => {
      // CREATE TABLE IF NOT EXISTS can still race in PostgreSQL's catalogs when
      // separate fresh backend instances initialize concurrently. Production
      // normally migrates this table first; serialize the compatibility fallback.
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended('steward:auth_kv_store:init', 0))
      `;
      await transaction`
        CREATE TABLE IF NOT EXISTS auth_kv_store (
          id          TEXT        NOT NULL,
          namespace   TEXT        NOT NULL,
          value       TEXT        NOT NULL,
          expires_at  TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (id, namespace)
        )
      `;
      await transaction`
        CREATE INDEX IF NOT EXISTS auth_kv_store_expires_idx
          ON auth_kv_store (expires_at)
      `;
    });
    this.initialized = true;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.ensureTable();
    const sql = this.getSqlClient();
    // postgres-js does not serialize Date instances as query parameters on all
    // supported runtimes. Bind an ISO-8601 string and let TIMESTAMPTZ perform
    // the type conversion server-side.
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await sql`
      INSERT INTO auth_kv_store (id, namespace, value, expires_at)
      VALUES (${key}, ${this.namespace}, ${value}, ${expiresAt})
      ON CONFLICT (id, namespace) DO UPDATE
        SET value      = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at
    `;
  }

  async setIfNotExists(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    await this.ensureTable();
    const sql = this.getSqlClient();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO auth_kv_store (id, namespace, value, expires_at)
      VALUES (${key}, ${this.namespace}, ${value}, ${expiresAt})
      ON CONFLICT (id, namespace) DO UPDATE
        SET value      = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at
        WHERE auth_kv_store.expires_at <= now()
      RETURNING id
    `;
    return rows.length > 0;
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

  async consume(key: string): Promise<string | null> {
    await this.ensureTable();
    const sql = this.getSqlClient();
    const rows = await sql<Array<{ value: string }>>`
      DELETE FROM auth_kv_store
       WHERE id        = ${key}
         AND namespace = ${this.namespace}
         AND expires_at > now()
      RETURNING value
    `;
    return rows[0]?.value ?? null;
  }

  async compareDelete(key: string, expected: string): Promise<boolean> {
    await this.ensureTable();
    const sql = this.getSqlClient();
    const rows = await sql<Array<{ id: string }>>`
      DELETE FROM auth_kv_store
       WHERE id = ${key}
         AND namespace = ${this.namespace}
         AND expires_at > clock_timestamp()
         AND value = ${expected}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async transition(
    key: string,
    expected: string,
    desired: string,
    ttlMs: number,
    guard?: { key: string; expected: string },
  ): Promise<boolean> {
    await this.ensureTable();
    const sql = this.getSqlClient();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const rows = guard
      ? await sql<Array<{ id: string }>>`
      UPDATE auth_kv_store
         SET value = ${desired}, expires_at = ${expiresAt}
       WHERE id = ${key}
         AND namespace = ${this.namespace}
         AND expires_at > now()
         AND (value = ${expected} OR value = ${desired})
         AND EXISTS (
           SELECT 1 FROM auth_kv_store AS guard_row
            WHERE guard_row.id = ${guard.key}
              AND guard_row.namespace = ${this.namespace}
              AND guard_row.expires_at > now()
              AND guard_row.value = ${guard.expected}
         )
      RETURNING id
    `
      : await sql<Array<{ id: string }>>`
      UPDATE auth_kv_store
         SET value = ${desired}, expires_at = ${expiresAt}
       WHERE id = ${key}
         AND namespace = ${this.namespace}
         AND expires_at > now()
         AND (value = ${expected} OR value = ${desired})
      RETURNING id
    `;
    return rows.length > 0;
  }

  async publish(entries: readonly StorePublishEntry[]): Promise<boolean> {
    assertUniquePublishKeys(entries);
    if (entries.length === 0) return true;
    await this.ensureTable();
    const sql = this.getSqlClient();
    const prepared = entries.map((entry) => ({
      ...entry,
      expiresAtIso: new Date(entry.expiresAt).toISOString(),
    }));
    const earliestValueExpiry = prepared
      .filter((entry) => entry.value !== null)
      .reduce<number | null>(
        (earliest, entry) =>
          earliest === null || entry.expiresAt < earliest
            ? entry.expiresAt
            : earliest,
        null,
      );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let published = true;
      try {
        await sql.begin("isolation level serializable", async (transaction) => {
          const ordered = [...prepared].sort((left, right) =>
            left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
          );
          const guarded = ordered.filter(
            (entry) => entry.expected !== undefined,
          );
          for (const entry of ordered) {
            // Cooperative publishers serialize absent rows here. SERIALIZABLE
            // additionally detects older binaries and ordinary writers that do
            // not participate in this advisory-lock protocol.
            await transaction`
              SELECT pg_advisory_xact_lock(
                hashtextextended(${`${this.namespace}:${entry.key}`}, 0)
              )
            `;
          }
          const valueDeadlineIsLive = async (): Promise<boolean> => {
            if (earliestValueExpiry === null) return true;
            // now() is fixed at transaction start and can predate a blocking
            // advisory lock. clock_timestamp() is authoritative at this
            // post-lock commit boundary.
            const [{ valid }] = await transaction<Array<{ valid: boolean }>>`
              SELECT clock_timestamp() < ${new Date(earliestValueExpiry).toISOString()}::timestamptz
                AS valid
            `;
            return valid;
          };
          if (!(await valueDeadlineIsLive())) {
            published = false;
            return;
          }
          let allExpected = true;
          let allDesired = guarded.length > 0;
          for (const entry of guarded) {
            const rows = await transaction<Array<{ value: string }>>`
              SELECT value
                FROM auth_kv_store
               WHERE id = ${entry.key}
                 AND namespace = ${this.namespace}
                 AND expires_at > clock_timestamp()
               LIMIT 1
            `;
            const current = rows[0]?.value ?? null;
            if (current !== entry.expected) allExpected = false;
            if (current !== entry.value) allDesired = false;
          }
          if (allDesired) return;
          if (!allExpected) {
            published = false;
            return;
          }
          for (const entry of prepared) {
            if (entry.value === null) {
              await transaction`
                DELETE FROM auth_kv_store
                 WHERE id = ${entry.key}
                   AND namespace = ${this.namespace}
              `;
            } else {
              await transaction`
                INSERT INTO auth_kv_store (id, namespace, value, expires_at)
                VALUES (${entry.key}, ${this.namespace}, ${entry.value}, ${entry.expiresAtIso})
                ON CONFLICT (id, namespace) DO UPDATE
                  SET value      = EXCLUDED.value,
                      expires_at = EXCLUDED.expires_at
              `;
            }
          }
          // A legacy writer or database lock can delay the UPSERT after the
          // first deadline check. Roll back the whole batch if that happened.
          if (!(await valueDeadlineIsLive()))
            throw new PublicationExpiredError();
        });
        return published;
      } catch (error) {
        if (error instanceof PublicationExpiredError) return false;
        if (postgresErrorCode(error) !== "40001" || attempt === 2) throw error;
      }
    }
    return false;
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
): Promise<{
  backend: StoreBackend;
  source: "redis" | "postgres" | "pglite" | "memory";
}> {
  // 1 — try Redis
  if (redisClient) {
    try {
      const backend = new RedisBackend(redisClient, `auth:${namespace}:`);
      // Smoke-test connectivity AND atomic-consume support: consume() needs
      // GETDEL (Redis >= 6.2), so probe it here — otherwise a server without
      // GETDEL would pass init yet throw on every consume() at runtime.
      await backend.set(`__ping__`, "1", 1000);
      await backend.consume(`__ping__`);
      return { backend, source: "redis" };
    } catch (err) {
      logger.warn(
        {
          details: [
            `[steward:auth] Redis backend unavailable for "${namespace}", falling back`,
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:store-backends] warn",
      );
    }
  }

  if (embeddedSql) {
    const backend = new PostgresBackend(namespace, embeddedSql);
    await backend.set("__ping__", "1", 1000);
    await backend.delete("__ping__");
    return { backend, source: "pglite" };
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
      logger.warn(
        {
          details: [
            `[steward:auth] Postgres backend unavailable for "${namespace}", falling back to memory`,
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:store-backends] warn",
      );
    }
  }

  // 3 — in-memory fallback
  logger.warn(
    {
      details: [
        `[steward:auth] Using in-memory backend for "${namespace}" — NOT suitable for multi-instance or restart-safe deployments`,
      ],
    },
    "[Login:store-backends] warn",
  );
  return { backend: new MemoryBackend(), source: "memory" };
}
