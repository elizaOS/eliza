// Pins the 401 recovery contract: when the cloud Worker redeploys, the token
// the gateway holds turns invalid until its scheduled refresh, up to ~48
// minutes away — and every cloud call in that window runs post-ack, so each
// 401 is a user-visible silence. Each call site must re-bootstrap once via the
// injected reauth hook and retry; a second 401 follows the normal error path,
// and a 404 must never trigger a re-bootstrap. The real reauth (single-flight
// against the token endpoint) is pinned separately below.
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { GatewayRedis } from "../src/redis";
import { resolveIdentity } from "../src/server-router";
import { resolveWebhookConfig } from "../src/webhook-config";

class MemoryRedis implements GatewayRedis {
  readonly store = new Map<string, string>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
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
const STALE = { Authorization: "Bearer stale" };

/** Upstream that 401s stale tokens and serves fresh ones. */
function upstream(body: unknown): { calls: Array<string | null> } {
  const seen: Array<string | null> = [];
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const auth = new Headers(init?.headers as HeadersInit).get("authorization");
    seen.push(auth);
    if (auth === "Bearer stale") {
      return new Response("unauthorized", { status: 401 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls: seen };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("resolveIdentity re-bootstraps once on 401", () => {
  test("stale token → reauth → retry succeeds and the identity is served", async () => {
    const { calls } = upstream({
      success: true,
      userId: "user-1",
      organizationId: "org-1",
      agentId: "agent-1",
    });
    const reauth = mock(async () => ({ Authorization: "Bearer fresh" }));

    const identity = await resolveIdentity(
      new MemoryRedis(),
      "https://api.test",
      STALE,
      "telegram",
      "42",
      undefined,
      reauth,
    );

    expect(reauth).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(identity).toEqual({
      userId: "user-1",
      organizationId: "org-1",
      agentId: "agent-1",
    });
  });

  test("a second 401 follows the error path — no retry loop", async () => {
    globalThis.fetch = mock(
      async () => new Response("unauthorized", { status: 401 }),
    ) as typeof fetch;
    const reauth = mock(async () => ({ Authorization: "Bearer fresh" }));

    await expect(
      resolveIdentity(
        new MemoryRedis(),
        "https://api.test",
        STALE,
        "telegram",
        "42",
        undefined,
        reauth,
      ),
    ).rejects.toThrow("Identity resolve failed: 401");
    expect(reauth).toHaveBeenCalledTimes(1);
  });

  test("a 404 is an unknown sender, never a reauth trigger", async () => {
    globalThis.fetch = mock(
      async () => new Response("not found", { status: 404 }),
    ) as typeof fetch;
    const reauth = mock(async () => ({ Authorization: "Bearer fresh" }));

    const identity = await resolveIdentity(
      new MemoryRedis(),
      "https://api.test",
      STALE,
      "telegram",
      "42",
      undefined,
      reauth,
    );

    expect(identity).toBeNull();
    expect(reauth).not.toHaveBeenCalled();
  });
});

describe("resolveWebhookConfig re-bootstraps once on 401", () => {
  test("stale token → reauth → retry returns the config", async () => {
    const { calls } = upstream({ verifyToken: "vt", appSecret: "as" });
    const reauth = mock(async () => ({ Authorization: "Bearer fresh" }));

    const config = await resolveWebhookConfig(
      new MemoryRedis(),
      "https://api.test",
      STALE,
      "whatsapp",
      "eliza-app",
      "agent-42",
      reauth,
    );

    expect(reauth).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(config).toEqual({ verifyToken: "vt", appSecret: "as" });
  });
});

describe("reacquireAuthHeader is single-flight", () => {
  test("concurrent 401 recoveries share one bootstrap request", async () => {
    // Drive the REAL auth module: init against a stub token endpoint, then
    // fire concurrent reacquisitions and count how many bootstrap POSTs land.
    let bootstraps = 0;
    globalThis.fetch = mock(async (input: unknown) => {
      if (String(input).endsWith("/api/internal/auth/token")) {
        bootstraps += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(
          JSON.stringify({
            access_token: `tok-${bootstraps}`,
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;

    const { initAuth, reacquireAuthHeader, shutdownAuth } = await import(
      "../src/auth"
    );
    await initAuth({
      cloudUrl: "https://api.test",
      bootstrapSecret: "bootstrap",
      podName: "test-pod",
    });
    expect(bootstraps).toBe(1);

    const headers = await Promise.all([
      reacquireAuthHeader(),
      reacquireAuthHeader(),
      reacquireAuthHeader(),
    ]);

    // One shared bootstrap for the burst, and every caller gets the SAME
    // fresh token from it.
    expect(bootstraps).toBe(2);
    for (const header of headers) {
      expect(header).toEqual({ Authorization: "Bearer tok-2" });
    }

    shutdownAuth();
  });
});
