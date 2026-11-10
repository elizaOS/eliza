/** Production CacheClient and Redis WASM adapter with explicit clock boundaries. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CacheClient } from "./client";

const savedEnvironment = { ...process.env };
const clients: CacheClient[] = [];
let wall: number;
let elapsed: number;
let wallClock: ReturnType<typeof spyOn>;
let elapsedClock: ReturnType<typeof spyOn>;
type RedisProbe = {
  redis: {
    client: {
      get(key: string): Promise<string | null>;
      call(...args: string[]): Promise<unknown>;
      del(...keys: string[]): Promise<unknown>;
      quit(): Promise<unknown>;
    };
  };
};
const raw = (client: CacheClient) => (client as unknown as RedisProbe).redis.client;
const prefix = "cache-circuit-conformance:";

beforeEach(() => {
  Object.assign(process.env, {
    CACHE_ENABLED: "true",
    CACHE_BACKEND: "wadis",
    CACHE_METRICS_SAMPLE_RATE: "0",
    MOCK_REDIS: "0",
    NODE_ENV: "test",
    ENVIRONMENT: "cache-circuit-conformance",
  });
  wall = Date.parse("2026-11-10T12:00:00Z");
  elapsed = 100_000;
  wallClock = spyOn(Date, "now").mockImplementation(() => wall);
  elapsedClock = spyOn(performance, "now").mockImplementation(() => elapsed);
});

afterEach(async () => {
  wallClock.mockRestore();
  elapsedClock.mockRestore();
  for (const client of clients.splice(0)) await raw(client).quit();
  for (const key of Object.keys(process.env))
    if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
});

async function failingClient(failures = 5): Promise<CacheClient> {
  const client = new CacheClient();
  clients.push(client);
  await client.set("authority", { version: "original" }, 3600);
  await client.pushQueueHead("wrong-type", "list-entry");
  for (let attempt = 0; attempt < failures; attempt++) {
    expect(await client.getWithOutcome("wrong-type")).toMatchObject({
      kind: "error",
      backend: "wadis",
    });
  }
  expect(client.isBackendConfigured()).toBe(true);
  expect(client.isAvailable()).toBe(failures < 5);
  return client;
}

test("a forward wall-clock jump cannot bypass the cache breaker cooldown", async () => {
  const client = await failingClient();
  wall += 3_600_000;
  expect(await client.getWithOutcome("authority")).toMatchObject({ kind: "unavailable" });
  expect(await client.delConfirmed("authority")).toBe(false);
  expect(await raw(client).get(`${prefix}authority`)).not.toBeNull();
});

test("elapsed cooldown permits a confirmed delete after a backward wall-clock jump", async () => {
  const client = await failingClient();
  wall -= 3_600_000;
  elapsed += 60_001;
  expect(await client.delConfirmed("authority")).toBe(true);
  expect(await raw(client).get(`${prefix}authority`)).toBeNull();
  expect(client.isAvailable()).toBe(true);
});

test("the exact cooldown boundary stays blocked and a later probe can fail", async () => {
  const client = await failingClient();
  elapsed += 60_000;
  expect(await client.delConfirmed("authority")).toBe(false);
  elapsed += 1;
  expect(await client.getWithOutcome("wrong-type")).toMatchObject({ kind: "error" });
  expect(client.isAvailable()).toBe(true);
  expect(await client.delConfirmed("authority")).toBe(true);
  expect(await raw(client).get(`${prefix}authority`)).toBeNull();
});

test("cache hits reset failures while successful misses retain them", async () => {
  const client = await failingClient(4);
  expect(await client.getWithOutcome("missing")).toMatchObject({ kind: "miss" });
  expect(await client.getWithOutcome("wrong-type")).toMatchObject({ kind: "error" });
  expect(client.isAvailable()).toBe(false);
  elapsed += 60_001;
  expect(await client.getWithOutcome("authority")).toMatchObject({ kind: "hit" });
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(await client.getWithOutcome("wrong-type")).toMatchObject({ kind: "error" });
  }
  expect(await client.getWithOutcome("authority")).toMatchObject({ kind: "hit" });
  expect(await client.getWithOutcome("wrong-type")).toMatchObject({ kind: "error" });
  expect(client.isAvailable()).toBe(true);
});

test("a rejected backend delete is unconfirmed and preserves the cached value", async () => {
  const client = await failingClient(0);
  await raw(client).call("ACL", "SETUSER", "default", "-del");
  try {
    expect(await client.delConfirmed("authority")).toBe(false);
    expect(await raw(client).get(`${prefix}authority`)).not.toBeNull();
  } finally {
    await raw(client).call("ACL", "SETUSER", "default", "+del");
  }
  expect(await client.delConfirmed("authority")).toBe(true);
  expect(await raw(client).get(`${prefix}authority`)).toBeNull();
});

test("already admitted reads can settle after the cache breaker opens", async () => {
  const client = await failingClient(0);
  const replies = await Promise.all(
    Array.from({ length: 6 }, () => client.getWithOutcome("wrong-type")),
  );
  expect(replies.map((reply) => reply.kind)).toEqual(Array(6).fill("error"));
  expect(await client.getWithOutcome("authority")).toMatchObject({ kind: "unavailable" });
  expect(await client.delConfirmed("authority")).toBe(false);
  elapsed += 60_001;
  const recovered = await Promise.all([
    ...Array.from({ length: 5 }, () => client.getWithOutcome("wrong-type")),
    client.getWithOutcome("authority"),
  ]);
  expect(recovered.map((reply) => reply.kind)).toEqual([...Array(5).fill("error"), "hit"]);
  expect(client.isAvailable()).toBe(true);
});

test("a lost reply after a real backend delete remains unconfirmed", async () => {
  const client = await failingClient(0);
  const backend = raw(client);
  const originalDelete = backend.del.bind(backend);
  backend.del = async (...keys) => {
    await originalDelete(...keys);
    throw new Error("lost delete acknowledgement after commit");
  };
  try {
    expect(await client.delConfirmed("authority")).toBe(false);
    expect(await backend.get(`${prefix}authority`)).toBeNull();
  } finally {
    backend.del = originalDelete;
  }
  expect(await client.delConfirmed("authority")).toBe(true);
});

test("a client with no selected backend confirms that it has nothing to invalidate", async () => {
  process.env.CACHE_ENABLED = "false";
  const client = new CacheClient();
  expect(client.isBackendConfigured()).toBe(false);
  expect(await client.delConfirmed("authority")).toBe(true);
  expect(await client.getWithOutcome("authority")).toMatchObject({ kind: "unavailable" });
});
