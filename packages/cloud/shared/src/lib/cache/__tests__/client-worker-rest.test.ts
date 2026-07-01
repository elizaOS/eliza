import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const constructedClients: Array<{ url: string; token: string }> = [];
const store = new Map<string, string>();

const realUpstash = await import("@upstash/redis");

class MockUpstashRedis {
  constructor(options: { url: string; token: string }) {
    constructedClients.push(options);
  }

  async get<T>(key: string): Promise<T | null> {
    return (store.get(key) ?? null) as T | null;
  }

  async setex(key: string, _ttlSeconds: number, value: string): Promise<"OK"> {
    store.set(key, value);
    return "OK";
  }

  async set(key: string, value: string, options?: { nx?: boolean }): Promise<"OK" | null> {
    if (options?.nx && store.has(key)) return null;
    store.set(key, value);
    return "OK";
  }

  async incr(key: string): Promise<number> {
    const next = Number(store.get(key) ?? "0") + 1;
    store.set(key, String(next));
    return next;
  }

  async expire(): Promise<number> {
    return 1;
  }

  async pexpire(): Promise<number> {
    return 1;
  }

  async pttl(): Promise<number> {
    return 60_000;
  }

  async getdel<T>(key: string): Promise<T | null> {
    const value = store.get(key) ?? null;
    store.delete(key);
    return value as T | null;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (store.delete(key)) count++;
    }
    return count;
  }

  async scan(): Promise<[number, string[]]> {
    return [0, Array.from(store.keys())];
  }

  async mget<T extends unknown[]>(...keys: string[]): Promise<T> {
    return keys.map((key) => store.get(key) ?? null) as T;
  }

  async lpush(): Promise<number> {
    return 1;
  }

  async rpop<T>(): Promise<T | null> {
    return null;
  }

  async llen(): Promise<number> {
    return 0;
  }
}

mock.module("@upstash/redis", () => ({ Redis: MockUpstashRedis }));

const { CacheClient } = await import("../client");
const { runWithCloudBindings } = await import("../../runtime/cloud-bindings");

afterAll(() => {
  mock.module("@upstash/redis", () => realUpstash);
});

beforeEach(() => {
  constructedClients.length = 0;
  store.clear();
});

describe("CacheClient in Worker envs", () => {
  test("uses Upstash REST bindings for durable shared-runtime history", async () => {
    await runWithCloudBindings(
      {
        CACHE_ENABLED: "true",
        CACHE_BACKEND: "redis-rest",
        ENVIRONMENT: "staging",
        KV_REST_API_URL: "https://upstash.example.test",
        KV_REST_API_TOKEN: "test-token",
        NODE_ENV: "production",
      },
      async () => {
        const cache = new CacheClient();
        const key = "shared-runtime:agent-1:conversation-1:history:v1";
        const history = [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
        ];

        expect(cache.isAvailable()).toBe(true);

        await cache.set(key, history, 60);

        expect(constructedClients).toEqual([
          {
            url: "https://upstash.example.test",
            token: "test-token",
          },
        ]);
        expect(store.has(`staging:${key}`)).toBe(true);
        expect(await cache.get(key)).toEqual(history);
      },
    );
  });
});
