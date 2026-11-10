/** Production cache adapters with explicit clock boundaries and isolated Redis. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CacheClient } from "./client";

const savedEnvironment = { ...process.env };
const nativeRedisUrl = process.env.CACHE_CIRCUIT_TEST_REDIS_URL;
if (nativeRedisUrl) {
  const endpoint = new URL(nativeRedisUrl);
  if (
    endpoint.protocol !== "redis:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    !endpoint.port ||
    endpoint.port === "6379" ||
    !endpoint.password
  )
    throw new Error("Native circuit tests require an authenticated private loopback Redis port");
}
const clients: CacheClient[] = [];
let wall: number;
let elapsed: number;
let wallClock: ReturnType<typeof spyOn>;
let elapsedClock: ReturnType<typeof spyOn>;
type RedisProbe = {
  redis: {
    client: {
      get(key: string): Promise<string | null>;
      call?(...args: string[]): Promise<unknown>;
      sendCommand?(args: string[]): Promise<unknown>;
      del(...keys: string[]): Promise<unknown>;
      quit(): Promise<unknown>;
    };
  };
};
const raw = (client: CacheClient) => (client as unknown as RedisProbe).redis.client;
function command(client: CacheClient, args: string[]): Promise<unknown> {
  const backend = raw(client);
  if (backend.call) return backend.call(...args);
  if (backend.sendCommand) return backend.sendCommand(args);
  throw new Error("Cache backend exposes no command interface");
}
const prefix = "cache-circuit-conformance:";

beforeEach(() => {
  Object.assign(process.env, {
    CACHE_ENABLED: "true",
    CACHE_BACKEND: nativeRedisUrl ? "redis" : "wadis",
    CACHE_METRICS_SAMPLE_RATE: "0",
    MOCK_REDIS: "0",
    NODE_ENV: "test",
    ENVIRONMENT: "cache-circuit-conformance",
  });
  if (nativeRedisUrl) process.env.REDIS_URL = nativeRedisUrl;
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
      backend: nativeRedisUrl ? "redis_native" : "wadis",
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
  await command(client, ["ACL", "SETUSER", "default", "-del"]);
  try {
    expect(await client.delConfirmed("authority")).toBe(false);
    expect(await raw(client).get(`${prefix}authority`)).not.toBeNull();
  } finally {
    await command(client, ["ACL", "SETUSER", "default", "+del"]);
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
  // Native Redis can deliver the successful response before earlier rejections
  // settle in JavaScript. A fresh acknowledged hit closes either resulting state.
  elapsed += 60_001;
  expect(await client.getWithOutcome("authority")).toMatchObject({ kind: "hit" });
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
