/**
 * Verifies one-shot JWT recovery for gateway-to-cloud requests.
 *
 * The deterministic harness covers identity and webhook-config retries plus
 * the real auth module's single-flight behavior. Handler-level onboarding
 * recovery is exercised by the webhook end-to-end suite.
 */
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
      // error-policy:J3 Test Redis mirrors string values that are not JSON.
      return value as T;
    }
  }

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
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
const STALE = { Authorization: "Bearer stale" };

/** Upstream that 401s stale tokens and serves fresh ones. */
function upstream(body: unknown): { calls: Array<string | null> } {
  const seen: Array<string | null> = [];
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
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
      "telegram",
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
    // Drive the auth module against a stub token endpoint, then count the
    // bootstrap POSTs from concurrent reacquisitions.
    let bootstraps = 0;
    globalThis.fetch = mock(async (input: unknown) => {
      if (String(input).endsWith("/api/internal/auth/token")) {
        bootstraps += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(
          JSON.stringify({
            access_token: `tok-${bootstraps}`,
            token_type: "Bearer",
            expires_in: 60,
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

    // One shared bootstrap serves the burst and returns one fresh token.
    expect(bootstraps).toBe(2);
    for (const header of headers) {
      expect(header).toEqual({ Authorization: "Bearer tok-2" });
    }

    shutdownAuth();
  });

  test("scheduled renewal re-bootstraps and never calls the bearer refresh route", async () => {
    const paths: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      paths.push(new URL(String(input)).pathname);
      return new Response(
        JSON.stringify({
          access_token: `tok-${paths.length}`,
          token_type: "Bearer",
          expires_in: 0.05,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { initAuth, shutdownAuth } = await import("../src/auth");
    try {
      await initAuth({
        cloudUrl: "https://api.test",
        bootstrapSecret: "bootstrap",
        podName: "test-pod",
      });
      await new Promise((resolve) => setTimeout(resolve, 70));
    } finally {
      shutdownAuth();
    }

    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths.every((path) => path === "/api/internal/auth/token")).toBe(
      true,
    );
  });

  test("rejects a malformed bootstrap response without installing it", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "invalid-token",
            token_type: "NotBearer",
            expires_in: -1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;

    const { getAuthHeader, initAuth, shutdownAuth } = await import(
      "../src/auth"
    );
    await expect(
      initAuth({
        cloudUrl: "https://api.test",
        bootstrapSecret: "bootstrap",
        podName: "test-pod",
      }),
    ).rejects.toThrow("Invalid gateway token response");
    expect(() => getAuthHeader()).toThrow("No access token available");
    shutdownAuth();
  });

  test("scheduled renewal retries bootstrap after a transient failure", async () => {
    let bootstraps = 0;
    globalThis.fetch = mock(async () => {
      bootstraps += 1;
      if (bootstraps === 2) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          access_token: `tok-${bootstraps}`,
          token_type: "Bearer",
          expires_in: bootstraps === 1 ? 0.01 : 60,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const { initAuth, shutdownAuth } = await import("../src/auth");
    try {
      await initAuth({
        cloudUrl: "https://api.test",
        bootstrapSecret: "bootstrap",
        podName: "test-pod",
      });
      await waitFor(() => bootstraps === 3);
    } finally {
      shutdownAuth();
    }

    expect(bootstraps).toBe(3);
  });

  test("shutdown fences an in-flight bootstrap from restoring auth state", async () => {
    let resolveBootstrap: ((response: Response) => void) | undefined;
    globalThis.fetch = mock(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveBootstrap = resolve;
        }),
    ) as typeof fetch;

    const { getAuthHeader, initAuth, shutdownAuth } = await import(
      "../src/auth"
    );
    const initialization = initAuth({
      cloudUrl: "https://api.test",
      bootstrapSecret: "bootstrap",
      podName: "test-pod",
    });
    await waitFor(() => resolveBootstrap !== undefined);
    shutdownAuth();
    resolveBootstrap?.(
      new Response(
        JSON.stringify({
          access_token: "late-token",
          token_type: "Bearer",
          expires_in: 60,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(initialization).rejects.toThrow("Auth lifecycle changed");
    expect(() => getAuthHeader()).toThrow("No access token available");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(() => getAuthHeader()).toThrow("No access token available");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for retry");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
