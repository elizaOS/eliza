/**
 * Selection-logic regression tests for operator's Redis client.
 *
 * Wave 4a added a `MOCK_REDIS=1` opt-in. The operator capability has only
 * two real branches (it always falls back to a hard-coded REDIS_URL when
 * unset, so there is no "missing creds" path here):
 *
 *   1. MOCK_REDIS=1   → ioredis-mock (in-memory)
 *   2. otherwise      → real ioredis bound to REDIS_URL or the in-cluster
 *                       default `redis://redis.eliza-infra.svc:6379`
 *
 * We mock `ioredis` so the non-mock path does not open a TCP socket during
 * the test.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

class FakeIORedis {
  static instances: FakeIORedis[] = [];
  static lastUrl: string | undefined;
  static lastOpts: unknown;
  public readonly isFake = true;
  constructor(url?: string, opts?: unknown) {
    FakeIORedis.lastUrl = url;
    FakeIORedis.lastOpts = opts;
    FakeIORedis.instances.push(this);
  }
  on() {
    return this;
  }
  multi() {
    return {
      set: () => ({ set: () => ({ exec: async () => [] }) }),
    };
  }
  set() {
    return Promise.resolve("OK");
  }
  del() {
    return Promise.resolve(0);
  }
}

mock.module("ioredis", () => ({
  default: FakeIORedis,
}));

const PREV = {
  MOCK_REDIS: process.env.MOCK_REDIS,
  REDIS_URL: process.env.REDIS_URL,
};

function clearEnv() {
  delete process.env.MOCK_REDIS;
  delete process.env.REDIS_URL;
}

beforeEach(() => {
  clearEnv();
  FakeIORedis.instances = [];
  FakeIORedis.lastUrl = undefined;
});

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("operator capabilities/redis selection", () => {
  test("MOCK_REDIS=1 → ioredis-mock (no FakeIORedis instantiated)", async () => {
    process.env.MOCK_REDIS = "1";
    process.env.REDIS_URL = "redis://should-not-be-used:6379";
    // Force a fresh module evaluation so the module-scoped `client` cache
    // doesn't leak across tests.
    delete require.cache?.[require.resolve?.("../redis") ?? ""];
    const mod = await import(`../redis?cb=${Date.now()}`);
    await mod.setServerState("srv", "ready", "http://srv");
    expect(FakeIORedis.instances.length).toBe(0);
  });

  test("MOCK_REDIS unset → real ioredis bound to REDIS_URL", async () => {
    process.env.REDIS_URL = "redis://real-host:6379";
    const mod = await import(`../redis?cb=${Date.now()}`);
    await mod.setServerState("srv", "ready", "http://srv");
    expect(FakeIORedis.instances.length).toBeGreaterThanOrEqual(1);
    expect(FakeIORedis.lastUrl).toBe("redis://real-host:6379");
  });

  test("MOCK_REDIS unset, no REDIS_URL → real ioredis bound to in-cluster default", async () => {
    const mod = await import(`../redis?cb=${Date.now()}`);
    await mod.setServerState("srv", "ready", "http://srv");
    expect(FakeIORedis.instances.length).toBeGreaterThanOrEqual(1);
    expect(FakeIORedis.lastUrl).toBe("redis://redis.eliza-infra.svc:6379");
  });
});
