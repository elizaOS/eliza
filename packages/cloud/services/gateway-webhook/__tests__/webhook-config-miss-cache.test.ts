/**
 * Pins the negative half of the per-agent webhook-config cache.
 *
 * An agent id that resolves to nothing must be remembered briefly: since
 * Meta's verification handshake became exempt from signature checking, this
 * lookup is reachable without a signature, and an uncached miss would let a
 * caller drive one authenticated round trip to the cloud API per request.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { GatewayRedis } from "../src/redis";
import { resolveWebhookConfig } from "../src/webhook-config";

class MemoryRedis implements GatewayRedis {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(
    key: string,
    value: string,
    options: { ex?: number } = {},
  ): Promise<unknown> {
    this.store.set(key, value);
    this.ttls.set(key, options.ex);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }

  async lpush(): Promise<unknown> {
    return 1;
  }

  async ltrim(): Promise<unknown> {
    return "OK";
  }

  async expire(): Promise<unknown> {
    return 1;
  }
}

const originalFetch = globalThis.fetch;
const AUTH = { Authorization: "Bearer gateway-jwt" };
const CACHE_KEY = "webhook-config:telegram:agent:agent-42";

function resolve(redis: GatewayRedis, agentId = "agent-42") {
  return resolveWebhookConfig(
    redis,
    "https://api.elizacloud.ai",
    AUTH,
    "telegram",
    "eliza-app",
    agentId,
  );
}

describe("per-agent webhook config cache", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("remembers an unknown agent id briefly instead of re-asking every time", async () => {
    const redis = new MemoryRedis();
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    expect(await resolve(redis)).toBeNull();
    expect(upstreamCalls).toBe(1);
    expect(redis.ttls.get(CACHE_KEY)).toBe(15);

    // Second request for the same unknown id is answered from Redis.
    expect(await resolve(redis)).toBeNull();
    expect(upstreamCalls).toBe(1);
  });

  test("caches a resolved config for the full TTL and returns it", async () => {
    const redis = new MemoryRedis();
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer gateway-jwt");
      return new Response(
        JSON.stringify({ verifyToken: "vt", appSecret: "as" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    expect(await resolve(redis)).toEqual({
      verifyToken: "vt",
      appSecret: "as",
    });
    expect(redis.ttls.get(CACHE_KEY)).toBe(300);
  });

  test("does not cache a transport failure, so a recovered API is reached again", async () => {
    // A 5xx or a network error is the cloud API being unwell, not a statement
    // about this agent id. Remembering it would extend an outage.
    const redis = new MemoryRedis();
    let upstreamCalls = 0;
    globalThis.fetch = mock(async () => {
      upstreamCalls += 1;
      return new Response("boom", { status: 500 });
    }) as typeof fetch;

    expect(await resolve(redis)).toBeNull();
    expect(redis.store.has(CACHE_KEY)).toBe(false);

    expect(await resolve(redis)).toBeNull();
    expect(upstreamCalls).toBe(2);
  });

  test("never queries the API for the shared (agent-less) config", async () => {
    const redis = new MemoryRedis();
    globalThis.fetch = mock(async () => {
      throw new Error("shared config must not hit the API");
    }) as typeof fetch;

    expect(
      await resolveWebhookConfig(
        redis,
        "https://api.elizacloud.ai",
        AUTH,
        "telegram",
        "eliza-app",
      ),
    ).not.toBeNull();
    expect(redis.store.size).toBe(0);
  });
});
