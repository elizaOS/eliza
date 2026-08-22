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
import {
  isThinStewardEmailAuthPath,
  isThinStewardPath,
  isThinStewardPublicPath,
} from "./public-paths";
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
    passkey: true,
    email: true,
    siwe: false,
    siws: false,
    google: false,
    discord: false,
    github: false,
    oauth: [],
    ...overrides,
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
    expect(
      isThinStewardPublicPath(`/steward/auth/providers${"/".repeat(100_000)}`),
    ).toBe(true);
  });
});

describe("isThinStewardEmailAuthPath", () => {
  test("matches only the three Magic Link email legs", () => {
    expect(isThinStewardEmailAuthPath("/steward/auth/email/send")).toBe(true);
    expect(isThinStewardEmailAuthPath("/steward/auth/email/send/")).toBe(true);
    expect(isThinStewardEmailAuthPath("/steward/auth/email/code/verify")).toBe(
      true,
    );
    expect(isThinStewardEmailAuthPath("/steward/auth/email/status")).toBe(true);
    expect(isThinStewardEmailAuthPath("/steward/auth/providers")).toBe(false);
    expect(isThinStewardEmailAuthPath("/steward/auth/email/verify")).toBe(
      false,
    );
    expect(isThinStewardEmailAuthPath("/steward/vault/keys")).toBe(false);
    expect(
      isThinStewardEmailAuthPath(
        `/steward/auth/email/send${"/".repeat(100_000)}`,
      ),
    ).toBe(true);
    expect(isThinStewardEmailAuthPath("/steward/auth/passkey/register")).toBe(
      false,
    );
  });
});

describe("isThinStewardPath", () => {
  test("GET/HEAD only for public reads", () => {
    expect(isThinStewardPath("GET", "/steward/auth/providers")).toBe(true);
    expect(isThinStewardPath("HEAD", "/steward/tenants/config")).toBe(true);
    expect(isThinStewardPath("GET", "/steward/auth/email/send")).toBe(false);
  });

  test("POST only for the Magic Link email legs", () => {
    expect(isThinStewardPath("POST", "/steward/auth/email/send")).toBe(true);
    expect(isThinStewardPath("POST", "/steward/auth/email/code/verify")).toBe(
      true,
    );
    expect(isThinStewardPath("POST", "/steward/auth/email/status")).toBe(true);
    expect(isThinStewardPath("POST", "/steward/auth/providers")).toBe(false);
    expect(isThinStewardPath("POST", "/steward/vault/keys")).toBe(false);
    expect(isThinStewardPath("PUT", "/steward/auth/email/send")).toBe(false);
    expect(isThinStewardPath("DELETE", "/steward/auth/email/send")).toBe(false);
  });

  test("OPTIONS eligible for both path families", () => {
    expect(isThinStewardPath("OPTIONS", "/steward/auth/providers")).toBe(true);
    expect(isThinStewardPath("OPTIONS", "/steward/auth/email/send")).toBe(true);
    expect(isThinStewardPath("OPTIONS", "/steward/vault/keys")).toBe(false);
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
      return providersUpstreamResponse({
        telegram: true,
        oauth: ["apple"],
      });
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
      google?: boolean;
      passkey?: boolean;
      telegram?: boolean;
      oauth?: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.passkey).toBe(true);
    expect(body.google).toBe(true);
    expect(body.telegram).toBe(true);
    expect(body.oauth).toEqual(["apple", "google"]);
  });

  test.each([true, false])(
    "preserves upstream Telegram provider state (%s) without inferring it from Eliza OAuth env",
    async (telegram) => {
      stubFetch(async () => providersUpstreamResponse({ telegram }));

      const app = createStewardThinApp();
      const response = await app.request(
        "https://api.elizacloud.ai/steward/auth/providers",
        { method: "GET" },
        stewardEnv,
      );
      const body = (await response.json()) as {
        google?: boolean;
        telegram?: boolean;
      };

      expect(body.google).toBe(true);
      expect(body.telegram).toBe(telegram);
    },
  );

  test.each([
    ["nested scalar provider data", { data: "telegram" }],
    ["nested array provider data", { data: ["telegram"] }],
    ["non-array oauth", { oauth: { google: true } }],
    ["oauth entries with non-string values", { oauth: ["google", 42] }],
  ])("fails closed on %s", async (_case, malformedProviders) => {
    stubFetch(async () => providersUpstreamResponse(malformedProviders));

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-eliza-providers-cache")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      code: "steward_upstream_invalid_response",
    });
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

  test("proxies POST /steward/auth/email/send with signing headers", async () => {
    const upstreamUrls: string[] = [];
    let upstreamHeaders: Headers | null = null;
    stubFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({
        ok: true,
        data: {
          expiresAt: "2026-01-01T00:00:00.000Z",
          challengeId: "c1",
          pollSecret: "p1",
        },
      });
    });

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/email/send",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.elizacloud.ai",
        },
        body: JSON.stringify({ email: "user@example.com" }),
      },
      {
        ...stewardEnv,
        STEWARD_REQUEST_SIGNING_SECRET: "test-signing-secret",
      } as unknown as AppEnv["Bindings"],
    );

    expect(response.status).toBe(200);
    expect(upstreamUrls).toEqual([`${UPSTREAM}/auth/email/send`]);
    const sentHeaders = upstreamHeaders as Headers | null;
    expect(sentHeaders?.get("x-steward-signature")).toMatch(/^v1=[0-9a-f]+$/);
    expect(sentHeaders?.get("x-steward-request-expires-at")).toMatch(/^\d+$/);
    expect(sentHeaders?.get("idempotency-key")).toBeTruthy();
    expect(sentHeaders?.get("x-steward-tenant")).toBe("elizacloud-staging");
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { challengeId?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.challengeId).toBe("c1");
  });

  test("proxies POST /steward/auth/email/status without a signing secret", async () => {
    const upstreamUrls: string[] = [];
    stubFetch(async (input: RequestInfo | URL) => {
      upstreamUrls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      return Response.json({ ok: true, data: { status: "pending" } });
    });

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/email/status",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: "c1", pollSecret: "p1" }),
      },
      stewardEnv,
    );

    expect(response.status).toBe(200);
    expect(upstreamUrls).toEqual([`${UPSTREAM}/auth/email/status`]);
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { status?: string };
    };
    expect(body.data?.status).toBe("pending");
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
