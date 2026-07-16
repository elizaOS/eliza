/**
 * Unit tests for `PostgresConnectionManager` that exercise the real `pg.Pool`
 * wiring without a live server: pool sizing from env, the per-connection
 * `hnsw.iterative_scan` GUC hook (driven through the pool's real `connect`
 * event), shutdown-state gating, and the failure path of `testConnection`
 * against an unreachable port. No mocks of the manager itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PostgresConnectionManager } from "../manager";

// Never reaches a server: connection attempts to this port fail fast.
const UNREACHABLE = "postgres://user:pass@127.0.0.1:1/testdb";

const managers: PostgresConnectionManager[] = [];
const make = (conn: string, rlsServerId?: string) => {
  const manager = new PostgresConnectionManager(conn, rlsServerId);
  managers.push(manager);
  return manager;
};

const ENV_KEYS = [
  "POSTGRES_POOL_MAX",
  "POSTGRES_POOL_MIN",
  "POSTGRES_POOL_IDLE_TIMEOUT_MS",
] as const;
const savedEnv = new Map<string, string | undefined>();

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  savedEnv.clear();
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

const setEnv = (key: (typeof ENV_KEYS)[number], value: string | undefined) => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

describe("PostgresConnectionManager", () => {
  it("defaults pool sizing and honors env overrides (ignoring invalid values)", () => {
    setEnv("POSTGRES_POOL_MAX", undefined);
    setEnv("POSTGRES_POOL_MIN", "0");
    setEnv("POSTGRES_POOL_IDLE_TIMEOUT_MS", "not-a-number");
    const defaulted = make(UNREACHABLE);
    const defaultOptions = defaulted.getConnection().options;
    expect(defaultOptions.max).toBe(20);
    expect(defaultOptions.min).toBe(0);
    // Invalid env falls back to the shipped default.
    expect(defaultOptions.idleTimeoutMillis).toBe(30000);

    setEnv("POSTGRES_POOL_MAX", "5");
    setEnv("POSTGRES_POOL_MIN", "1");
    setEnv("POSTGRES_POOL_IDLE_TIMEOUT_MS", "1234");
    const tuned = make(UNREACHABLE);
    const tunedOptions = tuned.getConnection().options;
    expect(tunedOptions.max).toBe(5);
    expect(tunedOptions.min).toBe(1);
    expect(tunedOptions.idleTimeoutMillis).toBe(1234);

    // Negative numbers are rejected, not clamped to zero.
    setEnv("POSTGRES_POOL_MAX", "-3");
    const negative = make(UNREACHABLE);
    expect(negative.getConnection().options.max).toBe(20);
  });

  it("tags the pool with the RLS server id as application_name", () => {
    setEnv("POSTGRES_POOL_MIN", "0");
    const manager = make(UNREACHABLE, "server-1234-rls");
    expect(manager.getConnection().options.application_name).toBe("server-1234-rls");
  });

  it("sets hnsw.iterative_scan = strict_order on every new pool connection", async () => {
    setEnv("POSTGRES_POOL_MIN", "0");
    const manager = make(UNREACHABLE);
    const queries: string[] = [];
    const client = {
      query: (text: string) => {
        queries.push(text);
        return Promise.resolve();
      },
    };
    // Drive the real Pool event the manager subscribed to in its constructor.
    manager.getConnection().emit("connect", client);
    await new Promise((resolve) => setImmediate(resolve));
    expect(queries).toEqual(["SET hnsw.iterative_scan = 'strict_order'"]);
  });

  it("swallows GUC failures from older pgvector without an unhandled rejection", async () => {
    setEnv("POSTGRES_POOL_MIN", "0");
    const manager = make(UNREACHABLE);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      manager.getConnection().emit("connect", {
        query: () =>
          Promise.reject(new Error('unrecognized configuration parameter "hnsw.iterative_scan"')),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("exposes the Drizzle handle and the underlying pool", () => {
    setEnv("POSTGRES_POOL_MIN", "0");
    const manager = make(UNREACHABLE);
    expect(manager.getDatabase()).toBeDefined();
    expect(manager.getConnection()).toBeDefined();
    expect(manager.isShuttingDown()).toBe(false);
  });

  it("returns false from testConnection when the server is unreachable", async () => {
    setEnv("POSTGRES_POOL_MIN", "0");
    const manager = make(UNREACHABLE);
    await expect(manager.testConnection()).resolves.toBe(false);
  });

  it("rejects client acquisition, entity-context work, and testConnection after close", async () => {
    setEnv("POSTGRES_POOL_MIN", "0");
    const manager = make(UNREACHABLE);
    await manager.close();
    expect(manager.isShuttingDown()).toBe(true);
    await expect(manager.getClient()).rejects.toThrow(/shutting down/);
    await expect(manager.withEntityContext(null, async () => 1)).rejects.toThrow(/shutting down/);
    await expect(manager.testConnection()).resolves.toBe(false);
  });

  it("close is idempotent and returns the same settled promise", async () => {
    setEnv("POSTGRES_POOL_MIN", "0");
    const manager = make(UNREACHABLE);
    const first = manager.close();
    const second = manager.close();
    await Promise.all([first, second]);
    // A third close after the pool has fully ended must also resolve.
    await expect(manager.close()).resolves.toBeUndefined();
  });
});
