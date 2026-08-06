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

  test("returns an account with no agent instead of throwing, on a short TTL", async () => {
    // The pre-agent answer is the one about to become false, so it is cached
    // only long enough to blunt retry storms — a container cannot boot inside
    // that window, so nothing user-visible is served stale.
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
    expect(redis.ttls.get(CACHE_KEY)).toBe(15);
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

  test("treats 404 as an unknown sender and caches it briefly", async () => {
    const redis = new MemoryRedis();
    respondWith({ success: false }, 404);

    expect(await resolve(redis)).toBeNull();
    expect(redis.ttls.get(CACHE_KEY)).toBe(15);
  });
});
