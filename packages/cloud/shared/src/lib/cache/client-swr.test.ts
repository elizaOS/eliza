/** Real HTTP loaders and production cache adapters; no mocked cache methods. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { CacheClient } from "./client";

type Probe = {
  revalidationQueue: Map<string, Promise<unknown>>;
  REVALIDATION_TIMEOUT_MS: number;
  redis: { client?: { quit(): Promise<unknown>; sendCommand(args: string[]): Promise<unknown> } };
};
const probe = (client: CacheClient) => client as unknown as Probe;
const savedEnvironment = { ...process.env };
const pendingResponses = new Set<ServerResponse>();
const counts = new Map<string, number>();
const clients: CacheClient[] = [];
let redis: ChildProcess | undefined;
let base = "";
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
  if (pathname.includes("failure")) response.writeHead(503).end("unavailable");
  else if (pathname.includes("stall")) {
    pendingResponses.add(response);
    response.on("close", () => pendingResponses.delete(response));
  } else response.end(JSON.stringify({ version: "fresh" }));
});
async function until(predicate: () => boolean, milliseconds = 3_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("SWR test condition timed out");
    await delay(5);
  }
}
function client(): CacheClient {
  const value = new CacheClient();
  // Same timeout transition, shortened for routine CI. The optional acceptance
  // mode retains the production 30 seconds and exercises the identical test.
  if (process.env.CACHE_SWR_TEST_REAL_DEADLINE !== "1") {
    probe(value).REVALIDATION_TIMEOUT_MS = 100;
  }
  clients.push(value);
  return value;
}
async function load(pathname: string): Promise<{ version: string }> {
  const response = await fetch(`${base}${pathname}`);
  if (!response.ok) throw new Error(`loader HTTP ${response.status}`);
  return response.json();
}
async function seed(value: CacheClient, key: string): Promise<void> {
  await value.set(key, { data: { version: "old" }, cachedAt: 0, staleAt: 0 }, 300);
}
beforeAll(async () => {
  const binary = process.env.CACHE_SWR_TEST_REDIS_BINARY;
  process.env.CACHE_ENABLED = "true";
  process.env.MOCK_REDIS = "0";
  process.env.CACHE_BACKEND = binary ? "redis" : "memory";
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "cache-swr-regression";
  if (binary) {
    const reserved = createNetServer();
    await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
    const port = (reserved.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
    redis = spawn(
      binary,
      ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      redis?.once("error", reject);
      redis?.once("exit", (code) => reject(new Error(`Redis exited during startup: ${code}`)));
      redis?.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("Ready to accept connections")) resolve();
      });
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  for (const response of pendingResponses) response.end(JSON.stringify({ version: "late" }));
  for (const value of clients) await until(() => probe(value).revalidationQueue.size === 0);
  for (const value of clients.splice(0)) await probe(value).redis?.client?.quit();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (redis && redis.exitCode === null && redis.signalCode === null) {
    const exited = new Promise<void>((resolve) => redis?.once("exit", () => resolve()));
    redis.kill("SIGTERM");
    await exited;
  }
  for (const key of Object.keys(process.env))
    if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
});

describe("CacheClient SWR loader lifetime", () => {
  test("propagates a cold loader failure after one HTTP request", async () => {
    const value = client();
    await expect(value.getWithSWR("cold-failure", 1, () => load("/cold-failure"))).rejects.toThrow(
      "loader HTTP 503",
    );
    expect(counts.get("/cold-failure")).toBe(1);
  });

  for (const outcome of ["success", "failure"] as const) {
    test(`clears the deadline timer after background ${outcome}`, async () => {
      const value = client();
      const key = `timer-${outcome}`;
      await seed(value, key);
      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      const timers = new Set<ReturnType<typeof setTimeout>>();
      globalThis.setTimeout = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const timer = originalSetTimeout(callback, timeout, ...args) as unknown as ReturnType<
          typeof setTimeout
        >;
        if (timeout === probe(value).REVALIDATION_TIMEOUT_MS) timers.add(timer);
        return timer;
      }) as unknown as typeof setTimeout;
      globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout> | undefined) => {
        if (timer !== undefined) timers.delete(timer);
        return originalClearTimeout(timer);
      }) as typeof clearTimeout;
      try {
        expect(await value.getWithSWR(key, 1, () => load(`/timer-${outcome}`))).toEqual({
          version: "old",
        });
        await until(() => probe(value).revalidationQueue.size === 0);
        expect(timers.size).toBe(0);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        for (const timer of timers) originalClearTimeout(timer);
      }
    });
  }

  test("keeps timed-out loader ownership through cache expiry and excludes its late write", async () => {
    const value = client();
    const key = "retained-loader";
    await seed(value, key);
    expect(await value.getWithSWR(key, 1, () => load("/stall"))).toEqual({ version: "old" });
    await until(() => counts.get("/stall") === 1);
    await delay(probe(value).REVALIDATION_TIMEOUT_MS + 30);
    expect(await value.getWithSWR(key, 1, () => load("/stall"))).toEqual({ version: "old" });
    await delay(10);
    expect(counts.get("/stall")).toBe(1);
    expect(probe(value).revalidationQueue.size).toBe(1);

    // A cache miss must not bypass ownership retained after timeout.
    await value.del(key);
    await expect(value.getWithSWR(key, 1, () => load("/stall"))).rejects.toThrow(
      "Revalidation timeout",
    );
    expect(counts.get("/stall")).toBe(1);
    for (const response of pendingResponses) response.end(JSON.stringify({ version: "late" }));
    await until(() => probe(value).revalidationQueue.size === 0);
    expect(await value.get(key)).toBeNull();
    expect(await value.getWithSWR(key, 1, () => load("/retry"))).toEqual({ version: "fresh" });
    expect(counts.get("/retry")).toBe(1);
  }, 40_000);

  test.skipIf(!process.env.CACHE_SWR_TEST_REDIS_BINARY)(
    "retains ownership until the real Redis cache write completes",
    async () => {
      const value = client();
      await seed(value, "slow-write");
      await probe(value).redis.client?.sendCommand(["CLIENT", "PAUSE", "400", "WRITE"]);
      expect(await value.getWithSWR("slow-write", 1, () => load("/slow-write"))).toEqual({
        version: "old",
      });
      await until(() => counts.get("/slow-write") === 1);
      await delay(150);
      expect(probe(value).revalidationQueue.size).toBe(1);
      // The native client orders this read after its blocked write. It must see
      // the new cache value without starting a second HTTP load.
      expect(await value.getWithSWR("slow-write", 1, () => load("/slow-write"))).toEqual({
        version: "fresh",
      });
      expect(counts.get("/slow-write")).toBe(1);
      await until(() => probe(value).revalidationQueue.size === 0);
      expect(await value.get("slow-write")).toMatchObject({ data: { version: "fresh" } });
    },
  );
});
