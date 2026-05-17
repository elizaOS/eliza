/**
 * Selection-logic regression tests for agent-server `getRedis()`.
 *
 * Wave 4a added a `MOCK_REDIS=1` opt-in. The agent-server has two branches:
 *
 *   1. MOCK_REDIS=1   → ioredis-mock (in-memory)
 *   2. otherwise      → real ioredis bound to `REDIS_URL` (required; throws
 *                       via getRequiredEnv when missing)
 *
 * We mock `ioredis` so the non-mock path never opens a real socket, and we
 * cache-bust the dynamic import so the module-scoped `client` does not leak
 * across cases.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

class FakeIORedis {
  static instances: FakeIORedis[] = [];
  static lastUrl: string | undefined;
  public readonly isFake = true;
  constructor(url?: string) {
    FakeIORedis.lastUrl = url;
    FakeIORedis.instances.push(this);
  }
  on() {
    return this;
  }
  get() {
    return Promise.resolve(null);
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

describe("agent-server getRedis selection", () => {
  test("MOCK_REDIS=1 → ioredis-mock (no FakeIORedis instantiated)", async () => {
    process.env.MOCK_REDIS = "1";
    process.env.REDIS_URL = "redis://should-not-be-used:6379";
    const { getRedis } = await import(`../../src/redis?cb=${Date.now()}`);
    const client = getRedis();
    expect(client.isFake).toBeUndefined();
    expect(FakeIORedis.instances.length).toBe(0);
  });

  test("MOCK_REDIS unset, REDIS_URL set → real ioredis bound to that URL", async () => {
    process.env.REDIS_URL = "redis://real-host:6379";
    const { getRedis } = await import(`../../src/redis?cb=${Date.now()}`);
    const client = getRedis();
    expect(client.isFake).toBe(true);
    expect(FakeIORedis.lastUrl).toBe("redis://real-host:6379");
  });

  test("MOCK_REDIS unset, no REDIS_URL → throws (getRequiredEnv)", async () => {
    const { getRedis } = await import(`../../src/redis?cb=${Date.now()}`);
    expect(() => getRedis()).toThrow();
  });
});
