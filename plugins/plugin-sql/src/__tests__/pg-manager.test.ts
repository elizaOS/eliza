/**
 * Unit coverage for PostgresConnectionManager: pool wiring (env-tunable
 * sizing, RLS application_name), the per-connection
 * `hnsw.iterative_scan = strict_order` init (set on connect, degrades to a
 * debug log when the GUC is missing), shutdown gating, connection testing,
 * and idempotent close. The `pg` Pool is mocked — no live Postgres; the real
 * query path is covered by the real-PGlite integration suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const poolMocks = vi.hoisted(() => {
  const instances: Array<{
    config: Record<string, unknown>;
    handlers: Map<string, (arg: unknown) => void>;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    ending: boolean;
    ended: boolean;
  }> = [];
  return { instances };
});

vi.mock("pg", () => ({
  Pool: class MockPool {
    config: Record<string, unknown>;
    handlers = new Map<string, (arg: unknown) => void>();
    connect = vi.fn();
    end = vi.fn(async () => {
      this.ended = true;
    });
    ending = false;
    ended = false;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      poolMocks.instances.push(this as never);
    }
    on(event: string, handler: (arg: unknown) => void) {
      this.handlers.set(event, handler);
      return this;
    }
  },
}));

import { PostgresConnectionManager } from "../pg/manager";

const CONN = "postgres://user:pass@db.example:5432/eliza";

function lastPool() {
  return poolMocks.instances[poolMocks.instances.length - 1];
}

describe("PostgresConnectionManager", () => {
  beforeEach(() => {
    poolMocks.instances.length = 0;
  });

  afterEach(() => {
    delete process.env.POSTGRES_POOL_MAX;
    delete process.env.POSTGRES_POOL_MIN;
  });

  it("builds the pool with default sizing and exposes pool + drizzle handles", () => {
    const manager = new PostgresConnectionManager(CONN);
    const pool = lastPool();

    expect(pool.config.max).toBe(20);
    expect(pool.config.min).toBe(2);
    expect(manager.getConnection()).toBe(pool as never);
    expect(manager.getDatabase()).toBeDefined();
    expect(manager.isShuttingDown()).toBe(false);
  });

  it("honors env pool sizing and stamps the RLS server id as application_name", () => {
    process.env.POSTGRES_POOL_MAX = "5";
    process.env.POSTGRES_POOL_MIN = "0";
    new PostgresConnectionManager(CONN, "0123456789abcdef");
    const pool = lastPool();

    expect(pool.config.max).toBe(5);
    expect(pool.config.min).toBe(0);
    expect(pool.config.application_name).toBe("0123456789abcdef");
  });

  it("rejects non-positive POSTGRES_POOL_MAX (falls back to the documented 20, not pg-pool's silent 10) but keeps 0 valid for min", () => {
    process.env.POSTGRES_POOL_MAX = "0";
    process.env.POSTGRES_POOL_MIN = "0";
    new PostgresConnectionManager(CONN);
    let pool = lastPool();

    expect(pool.config.max).toBe(20);
    expect(pool.config.min).toBe(0);

    process.env.POSTGRES_POOL_MAX = "-3";
    new PostgresConnectionManager(CONN);
    pool = lastPool();

    expect(pool.config.max).toBe(20);
  });

  it("sets hnsw.iterative_scan = strict_order on every new connection", async () => {
    new PostgresConnectionManager(CONN);
    const pool = lastPool();
    const client = { query: vi.fn(async () => ({})) };

    pool.handlers.get("connect")?.(client);

    expect(client.query).toHaveBeenCalledWith("SET hnsw.iterative_scan = 'strict_order'");
  });

  it("degrades quietly when the iterative_scan GUC does not exist (pgvector < 0.8)", async () => {
    new PostgresConnectionManager(CONN);
    const pool = lastPool();
    const client = {
      query: vi.fn(async () => {
        throw new Error('unrecognized configuration parameter "hnsw.iterative_scan"');
      }),
    };

    // Must not throw or produce an unhandled rejection.
    pool.handlers.get("connect")?.(client);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.query).toHaveBeenCalledOnce();
  });

  it("rejects client acquisition while shutting down and closes idempotently", async () => {
    const manager = new PostgresConnectionManager(CONN);
    const pool = lastPool();

    const closed = manager.close();
    const closedAgain = manager.close();
    await Promise.all([closed, closedAgain]);

    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(manager.isShuttingDown()).toBe(true);
    await expect(manager.getClient()).rejects.toThrow(/shutting down/);
  });

  it("testConnection returns true on a live SELECT 1 and false on failure", async () => {
    const manager = new PostgresConnectionManager(CONN);
    const pool = lastPool();
    const client = { query: vi.fn(async () => ({})), release: vi.fn() };
    pool.connect.mockResolvedValueOnce(client);

    await expect(manager.testConnection()).resolves.toBe(true);
    expect(client.query).toHaveBeenCalledWith("SELECT 1");
    expect(client.release).toHaveBeenCalled();

    pool.connect.mockRejectedValueOnce(new Error("connection refused"));
    await expect(manager.testConnection()).resolves.toBe(false);
  });
});
