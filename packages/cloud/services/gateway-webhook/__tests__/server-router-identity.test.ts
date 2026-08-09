// Pins how resolveIdentity reads the identity API: which responses are a real
// account, which are a malformed response worth throwing on, and how long each
// outcome may be cached. The fixtures use the flat shape the API actually emits.
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { GatewayRedis } from "../src/redis";
import { resolveIdentity } from "../src/server-router";

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
const AUTH = { Authorization: "Bearer internal-secret" };
const CACHE_KEY = "identity:telegram:9911";

function respondWith(body: unknown, status = 200): void {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as typeof fetch;
}

function resolve(redis: GatewayRedis) {
  return resolveIdentity(
    redis,
    "https://api.elizacloud.ai",
    AUTH,
    "telegram",
    "9911",
  );
}

describe("resolveIdentity", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("returns an account with no agent without caching the transition state", async () => {
    const redis = new MemoryRedis();
    respondWith({
      success: true,
      userId: "user-9",
      organizationId: "org-9",
      agentId: null,
    });

    expect(await resolve(redis)).toEqual({
      userId: "user-9",
      organizationId: "org-9",
      agentId: null,
    });
    expect(redis.store.has(CACHE_KEY)).toBe(false);
  });

  test("caches an account that owns an agent for the full identity TTL", async () => {
    const redis = new MemoryRedis();
    respondWith({
      success: true,
      userId: "user-9",
      organizationId: "org-9",
      agentId: "sandbox-9",
    });

    expect(await resolve(redis)).toEqual({
      userId: "user-9",
      organizationId: "org-9",
      agentId: "sandbox-9",
    });
    expect(redis.store.get(CACHE_KEY)).toBe(
      JSON.stringify({
        userId: "user-9",
        organizationId: "org-9",
        agentId: "sandbox-9",
      }),
    );
    expect(redis.ttls.get(CACHE_KEY)).toBe(300);
  });

  test("throws when the response omits the user or the organization", async () => {
    respondWith({ success: true, organizationId: "org-9", agentId: null });
    await expect(resolve(new MemoryRedis())).rejects.toThrow(
      "Identity resolve response missing userId or organizationId",
    );

    respondWith({ success: true, userId: "user-9", agentId: null });
    await expect(resolve(new MemoryRedis())).rejects.toThrow(
      "Identity resolve response missing userId or organizationId",
    );
  });

  test("treats 404 as an unknown sender without caching the transition state", async () => {
    const redis = new MemoryRedis();
    respondWith({ success: false }, 404);

    expect(await resolve(redis)).toBeNull();
    expect(redis.store.has(CACHE_KEY)).toBe(false);
  });

  test("observes an identity linked immediately after an unlinked lookup", async () => {
    const redis = new MemoryRedis();
    let requestCount = 0;
    globalThis.fetch = mock(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ success: false }), {
          status: 404,
        });
      }
      return new Response(
        JSON.stringify({
          success: true,
          userId: "user-9",
          organizationId: "org-9",
          agentId: "sandbox-9",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    expect(await resolve(redis)).toBeNull();
    expect(await resolve(redis)).toEqual({
      userId: "user-9",
      organizationId: "org-9",
      agentId: "sandbox-9",
    });
    expect(requestCount).toBe(2);
  });

  test("observes an agent assigned immediately after provisioning", async () => {
    const redis = new MemoryRedis();
    let requestCount = 0;
    globalThis.fetch = mock(async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({
          success: true,
          userId: "user-9",
          organizationId: "org-9",
          agentId: requestCount === 1 ? null : "sandbox-9",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    expect(await resolve(redis)).toEqual({
      userId: "user-9",
      organizationId: "org-9",
      agentId: null,
    });
    expect(await resolve(redis)).toEqual({
      userId: "user-9",
      organizationId: "org-9",
      agentId: "sandbox-9",
    });
    expect(requestCount).toBe(2);
  });
});
