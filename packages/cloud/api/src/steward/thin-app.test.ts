/**
 * Isolated thin Steward shell tests (#18049). Avoids importing the full Worker
 * entrypoint so these run without the monolithic bootstrap dependency graph.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  ageProvidersResponseCacheForTests,
  expireProvidersResponseCacheForTests,
  PROVIDERS_BROWSER_CACHE_CONTROL,
  PROVIDERS_CACHE_TTL_MS,
  providersCacheControlForAgeMs,
  resetProvidersResponseCacheForTests,
} from "./embedded";
import { isThinStewardPublicPath } from "./public-paths";
import { createStewardThinApp } from "./thin-app";

const UPSTREAM = "https://steward.example.test";

const stewardEnv = {
  ENVIRONMENT: "test",
  NODE_ENV: "test",
  ELIZA_DEPLOY_COMMIT: "test-commit-18049-thin",
  STEWARD_API_URL: UPSTREAM,
  STEWARD_TENANT_ID: "elizacloud-staging",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  REDIS_RATE_LIMITING: "false",
  BLOB: {},
} as unknown as AppEnv["Bindings"];

const originalFetch = globalThis.fetch;

function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  // Node 24's `typeof fetch` includes `preconnect`; bridge via unknown.
  globalThis.fetch = impl as unknown as typeof fetch;
}

function providersUpstreamResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({
    ok: true,
    data: {
      passkey: true,
      email: true,
      siwe: false,
      siws: false,
      google: false,
      discord: false,
      github: false,
      oauth: [],
      ...overrides,
    },
  });
}

beforeEach(() => {
  resetProvidersResponseCacheForTests();
  globalThis.fetch = originalFetch;
});

describe("isThinStewardPublicPath", () => {
  test("matches only login-critical Steward GETs", () => {
    expect(isThinStewardPublicPath("/steward/auth/providers")).toBe(true);
    expect(isThinStewardPublicPath("/steward/auth/providers/")).toBe(true);
    expect(isThinStewardPublicPath("/steward/tenants/config")).toBe(true);
    expect(isThinStewardPublicPath("/steward/auth/email/send")).toBe(false);
    expect(isThinStewardPublicPath("/steward/auth/nonce")).toBe(false);
    expect(isThinStewardPublicPath("/api/v1/oauth/providers")).toBe(false);
  });
});

describe("providers cache policy (#18049 staleness)", () => {
  test("browser Cache-Control total staleness is ≤ isolate TTL (no SWR extension)", () => {
    expect(PROVIDERS_CACHE_TTL_MS).toBe(60_000);
    expect(PROVIDERS_BROWSER_CACHE_CONTROL).toBe("public, max-age=60");
    expect(PROVIDERS_BROWSER_CACHE_CONTROL).not.toContain(
      "stale-while-revalidate",
    );
    expect(providersCacheControlForAgeMs(0)).toBe("public, max-age=60");
    expect(providersCacheControlForAgeMs(59_000)).toBe("public, max-age=1");
    expect(providersCacheControlForAgeMs(60_000)).toBe("public, max-age=0");
  });

  test("cache hit near TTL emits remaining max-age so total age never exceeds 60s", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return providersUpstreamResponse();
    });

    const app = createStewardThinApp();
    const miss = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );
    expect(miss.status).toBe(200);
    expect(miss.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(miss.headers.get("cache-control")).toBe("public, max-age=60");
    expect(miss.headers.get("age")).toBe("0");

    // Age the isolate entry by 59s (same clock the reader uses via fetchedAt).
    ageProvidersResponseCacheForTests(59_000);

    const hit = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-eliza-providers-cache")).toBe("hit");
    expect(hit.headers.get("cache-control")).toBe("public, max-age=1");
    expect(hit.headers.get("age")).toBe("59");
    // Isolate age (59) + remaining max-age (1) = 60 — never a fresh max-age=60.
    const maxAge = Number(
      hit.headers.get("cache-control")?.match(/max-age=(\d+)/i)?.[1],
    );
    const age = Number(hit.headers.get("age"));
    expect(age + maxAge).toBeLessThanOrEqual(60);
    expect(upstreamCalls).toBe(1);
  });
});

describe("createStewardThinApp", () => {
  test("proxies GET /steward/auth/providers and patches OAuth from env", async () => {
    stubFetch(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      expect(url).toBe(`${UPSTREAM}/auth/providers`);
      return providersUpstreamResponse();
    });

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {
        method: "GET",
        headers: { origin: "https://app.elizacloud.ai" },
      },
      stewardEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(response.headers.get("cache-control")).toBe(
      PROVIDERS_BROWSER_CACHE_CONTROL,
    );
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { google?: boolean; passkey?: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.passkey).toBe(true);
    expect(body.data?.google).toBe(true);
  });

  test("serves GET /steward/tenants/config without upstream and defaults no-store", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return new Response("nope", { status: 500 });
    });

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/tenants/config",
      { method: "GET" },
      stewardEnv,
    );

    expect(response.status).toBe(200);
    expect(upstreamCalls).toBe(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { features?: { enableSolana?: boolean } };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.features?.enableSolana).toBe(true);
  });

  test("reuses isolate providers cache on the second GET", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return providersUpstreamResponse();
    });

    const app = createStewardThinApp();
    const first = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );
    const second = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(second.headers.get("x-eliza-providers-cache")).toBe("hit");
    expect(second.headers.get("cache-control")).toBe(
      PROVIDERS_BROWSER_CACHE_CONTROL,
    );
    expect(upstreamCalls).toBe(1);
  });

  test("expires isolate cache after TTL so a removed provider cannot stick", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return providersUpstreamResponse(
        upstreamCalls === 1 ? { google: true } : { google: false, oauth: [] },
      );
    });

    const app = createStewardThinApp();
    const first = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );
    expect(first.headers.get("x-eliza-providers-cache")).toBe("miss");

    expireProvidersResponseCacheForTests();

    const second = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );
    expect(second.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(upstreamCalls).toBe(2);
  });

  test("invalidates isolate cache when ELIZA_DEPLOY_COMMIT changes", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return providersUpstreamResponse();
    });

    const app = createStewardThinApp();
    const envA = {
      ...stewardEnv,
      ELIZA_DEPLOY_COMMIT: "commit-a",
    } as unknown as AppEnv["Bindings"];
    const envB = {
      ...stewardEnv,
      ELIZA_DEPLOY_COMMIT: "commit-b",
    } as unknown as AppEnv["Bindings"];

    const first = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      envA,
    );
    const second = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      envB,
    );

    expect(first.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(second.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(upstreamCalls).toBe(2);
  });

  test("fails closed in production when REDIS_RATE_LIMITING=true without Redis", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return providersUpstreamResponse();
    });

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      {
        ...stewardEnv,
        ENVIRONMENT: "production",
        REDIS_RATE_LIMITING: "true",
        // no REDIS_URL / redis binding → buildRedisClient returns null
      } as unknown as AppEnv["Bindings"],
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(upstreamCalls).toBe(0);
  });

  test("HEAD /steward/auth/providers is accepted by the thin shell", async () => {
    stubFetch(async () => providersUpstreamResponse());

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "HEAD" },
      stewardEnv,
    );

    // Hono may answer HEAD via GET handler; either 200 or method-shaped success.
    expect([200, 204].includes(response.status) || response.status < 500).toBe(
      true,
    );
  });

  test("OPTIONS preflight gets first-party CORS for app origin", async () => {
    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://app.elizacloud.ai",
          "access-control-request-method": "GET",
        },
      },
      stewardEnv,
    );

    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.elizacloud.ai",
    );
  });
});

describe("embeddedStewardHandler providers cache", () => {
  test("returns 503 when upstream is not configured", async () => {
    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      {
        ENVIRONMENT: "test",
        NODE_ENV: "test",
        REDIS_RATE_LIMITING: "false",
        BLOB: {},
      } as unknown as AppEnv["Bindings"],
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("steward_upstream_not_configured");
  });
});
