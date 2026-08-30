/**
 * Unit coverage for the embedded Steward proxy. Drives the real handler
 * through a Hono shell: fetch is only the upstream network boundary.
 * Assertions record observed cache, upstream-selection, and patching
 * behaviour, plus parity with the release verifier on adversarial wire bodies.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { verifyStewardProviderDiscovery } from "../../../scripts/verify-steward-provider-discovery.mjs";
import {
  ageProvidersResponseCacheForTests,
  embeddedStewardHandler,
  expireProvidersResponseCacheForTests,
  PROVIDERS_BROWSER_CACHE_CONTROL,
  PROVIDERS_CACHE_TTL_MS,
  providersCacheControlForAgeMs,
  resetProvidersResponseCacheForTests,
} from "./embedded";

const UPSTREAM = "https://steward.example.test";
const ORIGINAL_FETCH = globalThis.fetch;

type Captured = {
  url: string;
  method: string;
  headers: Headers;
};

function providersData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    passkey: true,
    email: true,
    siwe: false,
    siws: false,
    google: false,
    discord: false,
    github: false,
    twitter: false,
    oauth: [],
    ...overrides,
  };
}

function providersJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ok: true, ...providersData(overrides) };
}

function makeApp(env: AppEnv["Bindings"]): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.env = env;
    await next();
  });
  app.all("/steward/*", embeddedStewardHandler);
  app.all("/steward", embeddedStewardHandler);
  return app;
}

function baseEnv(
  overrides: Record<string, string | undefined> = {},
): AppEnv["Bindings"] {
  return {
    STEWARD_API_URL: UPSTREAM,
    STEWARD_TENANT_ID: "elizacloud-staging",
    ...overrides,
  } as AppEnv["Bindings"];
}

function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers ?? {}),
    });
    return impl(input, init);
  }) as typeof globalThis.fetch;
  return calls;
}

beforeEach(() => {
  resetProvidersResponseCacheForTests();
  globalThis.fetch = ORIGINAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("providersCacheControlForAgeMs", () => {
  it("exports a 60s isolate TTL with a matching browser max-age and no SWR", () => {
    expect(PROVIDERS_CACHE_TTL_MS).toBe(60_000);
    expect(PROVIDERS_BROWSER_CACHE_CONTROL).toBe("public, max-age=60");
    expect(PROVIDERS_BROWSER_CACHE_CONTROL).not.toContain(
      "stale-while-revalidate",
    );
  });

  it.each([
    [-5_000, "public, max-age=60"],
    [0, "public, max-age=60"],
    [1, "public, max-age=60"],
    [999, "public, max-age=60"],
    [1_000, "public, max-age=59"],
    [30_000, "public, max-age=30"],
    [59_000, "public, max-age=1"],
    [59_001, "public, max-age=1"],
    [59_999, "public, max-age=1"],
    [60_000, "public, max-age=0"],
    [90_000, "public, max-age=0"],
  ] as const)("ageMs %d → %s", (ageMs, expected) => {
    expect(providersCacheControlForAgeMs(ageMs)).toBe(expected);
  });
});

describe("reset / expire / age test helpers", () => {
  it("reset of an empty cache is a no-op and expire of a missing entry does not throw", () => {
    resetProvidersResponseCacheForTests();
    expireProvidersResponseCacheForTests();
    ageProvidersResponseCacheForTests(1_000);
  });

  it("expire forces the next providers GET to miss even when the body is still young", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return Response.json(providersJson());
    });
    const app = makeApp(baseEnv());
    const miss = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(miss.headers.get("x-eliza-providers-cache")).toBe("miss");
    expireProvidersResponseCacheForTests();
    const again = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(again.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(upstreamCalls).toBe(2);
  });
});

describe("providers isolate cache capacity", () => {
  it("misses an empty cache and hits a single stored entry", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return Response.json(providersJson());
    });
    const app = makeApp(baseEnv());
    const miss = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    const hit = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(miss.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(hit.headers.get("x-eliza-providers-cache")).toBe("hit");
    expect(upstreamCalls).toBe(1);
  });

  it("evicts the oldest fetchedAt entry once eight distinct keys are stored", async () => {
    const calls: string[] = [];
    stubFetch(async (_input, init) => {
      const tenant = new Headers(init?.headers).get("x-steward-tenant") ?? "";
      calls.push(tenant);
      return Response.json(providersJson({ futureTenant: tenant }));
    });

    for (let i = 0; i < 8; i += 1) {
      const app = makeApp(baseEnv({ STEWARD_TENANT_ID: `tenant-${i}` }));
      const response = await app.request(
        "https://api.elizacloud.ai/steward/auth/providers",
      );
      expect(response.headers.get("x-eliza-providers-cache")).toBe("miss");
      ageProvidersResponseCacheForTests(10);
    }

    const ninth = makeApp(baseEnv({ STEWARD_TENANT_ID: "tenant-8" }));
    const ninthMiss = await ninth.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(ninthMiss.headers.get("x-eliza-providers-cache")).toBe("miss");

    // Observe remaining keys before re-fetching the evicted one — a miss on
    // tenant-0 would write a new entry and evict the next-oldest survivor.
    const surviving = makeApp(baseEnv({ STEWARD_TENANT_ID: "tenant-1" }));
    const survivor = await surviving.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(survivor.headers.get("x-eliza-providers-cache")).toBe("hit");

    const oldestAgain = makeApp(baseEnv({ STEWARD_TENANT_ID: "tenant-0" }));
    const oldest = await oldestAgain.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(oldest.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(calls.filter((tenant) => tenant === "tenant-0")).toHaveLength(2);
    expect(calls.filter((tenant) => tenant === "tenant-1")).toHaveLength(1);
  });

  it("does not evict when rewriting an existing key at capacity", async () => {
    stubFetch(async () => Response.json(providersJson()));
    for (let i = 0; i < 8; i += 1) {
      await makeApp(baseEnv({ STEWARD_TENANT_ID: `cap-${i}` })).request(
        "https://api.elizacloud.ai/steward/auth/providers",
      );
    }
    const rewrite = await makeApp(
      baseEnv({ STEWARD_TENANT_ID: "cap-7" }),
    ).request("https://api.elizacloud.ai/steward/auth/providers");
    expect(rewrite.headers.get("x-eliza-providers-cache")).toBe("hit");
    const first = await makeApp(
      baseEnv({ STEWARD_TENANT_ID: "cap-0" }),
    ).request("https://api.elizacloud.ai/steward/auth/providers");
    expect(first.headers.get("x-eliza-providers-cache")).toBe("hit");
  });
});

describe("resolveStewardUpstream", () => {
  it("returns 503 when neither upstream candidate is configured", async () => {
    const app = makeApp({} as AppEnv["Bindings"]);
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "steward_upstream_not_configured",
    });
  });

  it("skips empty, whitespace, malformed, and non-http candidates", async () => {
    const calls = stubFetch(async () => Response.json(providersJson()));
    const app = makeApp(
      baseEnv({
        STEWARD_API_URL: "   ",
        NEXT_PUBLIC_STEWARD_API_URL: "ftp://steward.example.test",
      }),
    );
    const empty = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(empty.status).toBe(503);
    expect(calls).toHaveLength(0);

    const malformed = await makeApp(
      baseEnv({
        STEWARD_API_URL: "not a url",
        NEXT_PUBLIC_STEWARD_API_URL: undefined,
      }),
    ).request("https://api.elizacloud.ai/steward/auth/providers");
    expect(malformed.status).toBe(503);
  });

  it("skips a same-origin /steward loopback URL and uses the next candidate", async () => {
    const calls = stubFetch(async () => Response.json(providersJson()));
    const app = makeApp(
      baseEnv({
        STEWARD_API_URL: "https://api.elizacloud.ai/steward/",
        NEXT_PUBLIC_STEWARD_API_URL: `${UPSTREAM}/`,
      }),
    );
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${UPSTREAM}/auth/providers`);
  });

  it("falls back to NEXT_PUBLIC_STEWARD_API_URL when STEWARD_API_URL is absent", async () => {
    const calls = stubFetch(async () => Response.json(providersJson()));
    const app = makeApp(
      baseEnv({
        STEWARD_API_URL: undefined,
        NEXT_PUBLIC_STEWARD_API_URL: UPSTREAM,
      }),
    );
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(`${UPSTREAM}/auth/providers`);
  });

  it("prefers STEWARD_API_URL over NEXT_PUBLIC_STEWARD_API_URL", async () => {
    const calls = stubFetch(async () => Response.json(providersJson()));
    const app = makeApp(
      baseEnv({
        STEWARD_API_URL: "https://primary.example.test",
        NEXT_PUBLIC_STEWARD_API_URL: "https://secondary.example.test",
      }),
    );
    await app.request("https://api.elizacloud.ai/steward/auth/providers");
    expect(calls[0]?.url).toBe("https://primary.example.test/auth/providers");
  });

  it("accepts an http upstream", async () => {
    const calls = stubFetch(async () => Response.json(providersJson()));
    const app = makeApp(
      baseEnv({ STEWARD_API_URL: "http://steward.internal.test" }),
    );
    await app.request("https://api.elizacloud.ai/steward/auth/providers");
    expect(calls[0]?.url).toBe("http://steward.internal.test/auth/providers");
  });
});

describe("public tenant config short-circuit", () => {
  it("serves GET /steward/tenants/config without fetching upstream", async () => {
    const calls = stubFetch(async () => new Response("nope", { status: 500 }));
    const response = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/tenants/config",
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
    const body = (await response.json()) as {
      ok: boolean;
      data: { features: { enableSolana: boolean; showSecretManager: boolean } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.features.enableSolana).toBe(true);
    expect(body.data.features.showSecretManager).toBe(false);
  });

  it("HEAD /steward/tenants/config keeps status and strips the body", async () => {
    const response = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/tenants/config",
      { method: "HEAD" },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("treats a trailing slash as the same public config path", async () => {
    const response = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/tenants/config/",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });
});

describe("embeddedStewardHandler proxy", () => {
  it("forwards search params, x-forwarded-* headers, and strips Host", async () => {
    const calls = stubFetch(async () => Response.json({ ok: true }));
    await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/nonce?chain=solana",
      { headers: { host: "api.elizacloud.ai" } },
    );
    expect(calls[0]?.url).toBe(`${UPSTREAM}/auth/nonce?chain=solana`);
    expect(calls[0]?.headers.get("x-forwarded-host")).toBe("api.elizacloud.ai");
    expect(calls[0]?.headers.get("x-forwarded-proto")).toBe("https");
    expect(calls[0]?.headers.get("host")).toBeNull();
  });

  it("maps /steward with no extra path to upstream /", async () => {
    const calls = stubFetch(async () => Response.json({ ok: true }));
    await makeApp(baseEnv()).request("https://api.elizacloud.ai/steward");
    expect(calls[0]?.url).toBe(`${UPSTREAM}/`);
  });

  it("does not pin a blank or whitespace-only tenant", async () => {
    const calls = stubFetch(async () => Response.json({ ok: true }));
    await makeApp(baseEnv({ STEWARD_TENANT_ID: "   " })).request(
      "https://api.elizacloud.ai/steward/auth/nonce",
    );
    expect(calls[0]?.headers.get("x-steward-tenant")).toBeNull();
  });

  it("preserves accept-encoding on non-providers passthrough requests", async () => {
    const calls = stubFetch(async () => Response.json({ ok: true }));
    await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/nonce",
      { headers: { "accept-encoding": "gzip, br" } },
    );
    expect(calls[0]?.headers.get("accept-encoding")).toBe("gzip, br");
  });

  it("signs PUT, PATCH, and DELETE when a signing secret is configured", async () => {
    const calls = stubFetch(async () => new Response("ok", { status: 200 }));
    const env = baseEnv({
      STEWARD_REQUEST_SIGNING_SECRET: "test_only_steward_secret_aaaaaaaaaaaaa",
    });
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      await makeApp(env).request(
        "https://api.elizacloud.ai/steward/vault/keys",
        {
          method,
          body: "{}",
          headers: { "content-type": "application/json" },
        },
      );
    }
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.headers.get("x-steward-signature")).toMatch(
        /^v1=[0-9a-f]{64}$/,
      );
      expect(call.headers.get("x-steward-request-expires-at")).toMatch(/^\d+$/);
      expect(call.headers.get("idempotency-key")).toBeTruthy();
    }
  });

  it("does not cache a non-providers GET", async () => {
    stubFetch(async () => Response.json({ ok: true, nonce: "n" }));
    const first = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/nonce",
    );
    const second = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/nonce",
    );
    expect(first.headers.get("x-eliza-providers-cache")).toBeNull();
    expect(second.headers.get("x-eliza-providers-cache")).toBeNull();
  });

  it("maps a non-providers transport failure to steward_upstream_unavailable", async () => {
    stubFetch(async () => {
      throw new Error("upstream timed out");
    });
    const response = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/nonce",
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "steward_upstream_unavailable",
      error: "steward_upstream_unavailable",
    });
  });

  it("maps a providers transport failure to 502 no-store", async () => {
    stubFetch(async () => {
      throw new Error("providers down");
    });
    const response = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "steward_upstream_unavailable",
    });
  });
});

describe("patchProvidersResponse", () => {
  it("removes inbound accept-encoding before reading uncompressed provider JSON", async () => {
    const calls = stubFetch(async (_input, init) => {
      expect(new Headers(init?.headers).get("accept-encoding")).toBeNull();
      return Response.json(providersJson());
    });
    const response = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { headers: { "accept-encoding": "gzip, br" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(calls[0]?.headers.get("accept-encoding")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("fails closed without caching when an upstream still returns compressed bytes", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      const compressed = new Blob([JSON.stringify(providersJson())])
        .stream()
        .pipeThrough(new CompressionStream("gzip"));
      return new Response(compressed, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      });
    });
    const app = makeApp(baseEnv());
    const first = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { headers: { "accept-encoding": "gzip, br" } },
    );
    expect(first.status).toBe(502);
    expect(first.headers.get("cache-control")).toBe("no-store");
    await expect(first.json()).resolves.toMatchObject({
      code: "steward_upstream_invalid_response",
    });

    const retry = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { headers: { "accept-encoding": "gzip, br" } },
    );
    expect(retry.status).toBe(502);
    expect(retry.headers.get("x-eliza-providers-cache")).toBeNull();
    expect(upstreamCalls).toBe(2);
  });

  it("classifies an upstream 404 without logging its body", async () => {
    const sensitiveBody = "private-upstream-diagnostic-must-not-be-logged";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    stubFetch(
      async () =>
        new Response(sensitiveBody, {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );

    expect(response.status).toBe(502);
    expect(warn).toHaveBeenCalledWith(
      "[embedded-steward] invalid providers response",
      { reason: "upstream_status", upstreamStatus: 404 },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitiveBody);
  });

  it.each([
    {
      reason: "media_type",
      response: () => new Response("not-json"),
    },
    {
      reason: "body",
      response: () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    {
      reason: "json",
      response: () =>
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    {
      reason: "envelope",
      response: () => Response.json({ ok: false, ...providersData() }),
    },
    {
      reason: "provider_contract",
      response: () =>
        Response.json({
          ok: true,
          data: providersData({ passkey: "invalid" }),
        }),
    },
  ])("logs only the bounded $reason reason", async ({ reason, response }) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    stubFetch(async () => response());

    const result = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );

    expect(result.status).toBe(502);
    expect(warn).toHaveBeenCalledWith(
      "[embedded-steward] invalid providers response",
      { reason },
    );
  });

  it("patches discord and github from env credentials without duplicating oauth entries", async () => {
    stubFetch(async () =>
      Response.json(
        providersJson({
          google: true,
          oauth: ["google", "apple"],
        }),
      ),
    );
    const response = await makeApp(
      baseEnv({
        GOOGLE_CLIENT_ID: "g-id",
        GOOGLE_CLIENT_SECRET: "g-secret",
        DISCORD_CLIENT_ID: "d-id",
        DISCORD_CLIENT_SECRET: "d-secret",
        GITHUB_CLIENT_ID: "gh-id",
        GITHUB_CLIENT_SECRET: "gh-secret",
      }),
    ).request("https://api.elizacloud.ai/steward/auth/providers");
    const body = (await response.json()) as {
      google: boolean;
      discord: boolean;
      github: boolean;
      oauth: string[];
    };
    expect(body.google).toBe(true);
    expect(body.discord).toBe(true);
    expect(body.github).toBe(true);
    expect(body.oauth).toEqual(["google", "apple", "discord", "github"]);
  });

  it("accepts application/json with a charset and +json content types", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify(providersJson()), {
          status: 200,
          headers: { "content-type": "application/json; charset=UTF-8" },
        }),
    );
    const charset = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(charset.status).toBe(200);

    resetProvidersResponseCacheForTests();
    stubFetch(
      async () =>
        new Response(JSON.stringify(providersJson()), {
          status: 200,
          headers: { "content-type": "application/vnd.api+json" },
        }),
    );
    const plusJson = await makeApp(
      baseEnv({ STEWARD_TENANT_ID: "plus-json" }),
    ).request("https://api.elizacloud.ai/steward/auth/providers");
    expect(plusJson.status).toBe(200);
  });

  it("fails closed on ok-but-not-200 statuses", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify(providersJson()), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const created = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(created.status).toBe(502);

    resetProvidersResponseCacheForTests();
    stubFetch(
      async () =>
        new Response(null, {
          status: 204,
          headers: { "content-type": "application/json" },
        }),
    );
    const empty = await makeApp(
      baseEnv({ STEWARD_TENANT_ID: "no-content" }),
    ).request("https://api.elizacloud.ai/steward/auth/providers");
    expect(empty.status).toBe(502);
  });

  it("fails closed on trailing JSON, invalid UTF-8, and oversized arrays", async () => {
    const required = `"passkey":true,"email":true,"siwe":false,"siws":false,"google":false,"discord":false,"github":false,"twitter":false,"oauth":[]`;
    stubFetch(
      async () =>
        new Response(`{"ok":true,${required}} trailing`, {
          headers: { "content-type": "application/json" },
        }),
    );
    const trailing = await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/providers",
    );
    expect(trailing.status).toBe(502);

    resetProvidersResponseCacheForTests();
    stubFetch(
      async () =>
        new Response(Uint8Array.from([0xff, 0xfe, 0xfd]), {
          headers: { "content-type": "application/json" },
        }),
    );
    const binary = await makeApp(
      baseEnv({ STEWARD_TENANT_ID: "utf8" }),
    ).request("https://api.elizacloud.ai/steward/auth/providers");
    expect(binary.status).toBe(502);

    resetProvidersResponseCacheForTests();
    const huge = {
      ok: true,
      ...providersData({
        oauth: Array.from({ length: 257 }, (_, i) => `p${i}`),
      }),
    };
    stubFetch(
      async () =>
        new Response(JSON.stringify(huge), {
          headers: { "content-type": "application/json" },
        }),
    );
    const overflow = await makeApp(
      baseEnv({ STEWARD_TENANT_ID: "overflow" }),
    ).request("https://api.elizacloud.ai/steward/auth/providers");
    expect(overflow.status).toBe(502);
  });

  it("strips inbound credentials on the public providers path", async () => {
    const calls = stubFetch(async () => Response.json(providersJson()));
    await makeApp(baseEnv()).request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {
        headers: {
          authorization: "Bearer secret",
          cookie: "session=secret",
          "x-api-key": "k",
          "x-steward-key": "k",
          "x-steward-platform-key": "k",
          "x-steward-signer-id": "id",
          "x-steward-signer-secret": "s",
          "x-steward-key-quorum-id": "q",
          "x-steward-key-quorum-credentials": "c",
        },
      },
    );
    const headers = calls[0]?.headers;
    expect(headers?.get("authorization")).toBeNull();
    expect(headers?.get("cookie")).toBeNull();
    expect(headers?.get("x-api-key")).toBeNull();
    expect(headers?.get("x-steward-key")).toBeNull();
    expect(headers?.get("x-steward-platform-key")).toBeNull();
    expect(headers?.get("x-steward-signer-id")).toBeNull();
    expect(headers?.get("x-steward-signer-secret")).toBeNull();
    expect(headers?.get("x-steward-key-quorum-id")).toBeNull();
    expect(headers?.get("x-steward-key-quorum-credentials")).toBeNull();
  });

  it("HEAD of a cached providers entry returns an empty body", async () => {
    stubFetch(async () => Response.json(providersJson()));
    const app = makeApp(baseEnv());
    await app.request("https://api.elizacloud.ai/steward/auth/providers");
    const head = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("x-eliza-providers-cache")).toBe("hit");
    expect(await head.text()).toBe("");
  });
});

describe("provider contract parity with the release verifier", () => {
  const upstreamOrigin = "https://steward-api-staging.up.railway.app";
  const flatBody = JSON.stringify(providersJson());
  const flatMembers = flatBody.slice(1, -1);
  const encoder = new TextEncoder();
  const withFuture = (rawJson: string): string =>
    `{${flatMembers},"future":${rawJson}}`;

  async function assertParity(
    body: string | Uint8Array<ArrayBuffer>,
    expectedAccepted: boolean,
  ): Promise<void> {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const calls = stubFetch(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await makeApp(
      baseEnv({ STEWARD_API_URL: upstreamOrigin }),
    ).request("https://api-staging.eliza.app/steward/auth/providers");
    const [verification] = await Promise.allSettled([
      verifyStewardProviderDiscovery(
        {
          baseUrl: upstreamOrigin,
          environment: "staging",
          surface: "upstream",
        },
        { fetchImpl: globalThis.fetch },
      ),
    ]);

    expect(response.status).toBe(expectedAccepted ? 200 : 502);
    expect(verification.status).toBe(
      expectedAccepted ? "fulfilled" : "rejected",
    );
    expect(verification.status === "fulfilled").toBe(response.status === 200);
    await expect(response.json()).resolves.toMatchObject(
      expectedAccepted
        ? { ok: true }
        : { code: "steward_upstream_invalid_response" },
    );
    if (!expectedAccepted) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: `${upstreamOrigin}/auth/providers`, method: "GET" },
      { url: `${upstreamOrigin}/auth/providers`, method: "GET" },
    ]);
  }

  it.each([
    { name: "flat contract", payload: providersJson() },
    { name: "nested contract", payload: { ok: true, data: providersData() } },
    {
      name: "flat contract with a future data field",
      payload: providersJson({ data: { futureEnvelopeField: true } }),
    },
    {
      name: "nested contract with unvalidated contract-named siblings",
      payload: { ok: true, passkey: "invalid", data: providersData() },
    },
    {
      name: "optional providers and Turnstile captcha",
      payload: providersJson({
        sms: true,
        whatsapp: false,
        telegram: true,
        oidc: ["partner"],
        disabled: ["github"],
        captcha: {
          enabled: true,
          provider: "turnstile",
          siteKey: "public-test-site-key",
          requiredFor: ["email_otp", "sms_otp"],
        },
      }),
    },
    {
      name: "nested hCaptcha with forward-compatible Unicode metadata",
      payload: {
        ok: true,
        data: providersData({
          captcha: { provider: "hcaptcha", future: "雪" },
        }),
      },
    },
  ])("accepts $name on both boundaries", async ({ payload }) => {
    await assertParity(JSON.stringify(payload), true);
  });

  it.each([
    { name: "failed envelope", payload: { ...providersJson(), ok: false } },
    { name: "error envelope", payload: providersJson({ error: null }) },
    { name: "failed success flag", payload: providersJson({ success: false }) },
    { name: "array provider data", payload: { ok: true, data: [] } },
    {
      name: "invalid required boolean",
      payload: { ok: true, data: providersData({ passkey: "true" }) },
    },
    { name: "invalid oauth list", payload: providersJson({ oauth: [false] }) },
    {
      name: "invalid optional boolean",
      payload: providersJson({ telegram: "yes" }),
    },
    { name: "invalid oidc list", payload: providersJson({ oidc: [12] }) },
    {
      name: "invalid disabled list",
      payload: providersJson({ disabled: "github" }),
    },
    { name: "null captcha", payload: providersJson({ captcha: null }) },
    {
      name: "invalid captcha enabled flag",
      payload: providersJson({ captcha: { enabled: "true" } }),
    },
    {
      name: "unsupported captcha provider",
      payload: providersJson({ captcha: { provider: "unknown" } }),
    },
    {
      name: "invalid captcha site key",
      payload: providersJson({ captcha: { siteKey: 12 } }),
    },
    {
      name: "invalid captcha requirement list",
      payload: providersJson({ captcha: { requiredFor: "email_otp" } }),
    },
    {
      name: "unsupported captcha requirement",
      payload: providersJson({ captcha: { requiredFor: ["unknown"] } }),
    },
  ])("rejects $name on both boundaries", async ({ payload }) => {
    await assertParity(JSON.stringify(payload), false);
  });

  it.each([
    {
      name: "duplicate provider key",
      body: `{${flatMembers},"passkey":false}`,
    },
    {
      name: "escaped duplicate provider key",
      body: `{${flatMembers},"pass\\u006bey":false}`,
    },
    {
      name: "escaped duplicate nested unknown key",
      body: withFuture('{"key":1,"\\u006bey":2}'),
    },
    ...["__proto__", "prototype", "constructor"].map((key) => ({
      name: `nested dangerous ${key} key`,
      body: withFuture(`[{"${key}":{}}]`),
    })),
    {
      name: "escaped nested dangerous key",
      body: withFuture('{"\\u0063onstructor":{}}'),
    },
    { name: "second JSON document", body: `${flatBody} {"extra":true}` },
    {
      name: "invalid UTF-8 inside otherwise valid provider JSON",
      body: Uint8Array.from([
        ...encoder.encode(`{${flatMembers},"future":"`),
        0xff,
        ...encoder.encode('"}'),
      ]),
    },
  ])("rejects $name on both wire parsers", async ({ body }) => {
    await assertParity(body, false);
  });

  it.each([
    { name: "depth 16", depth: 15, accepted: true },
    { name: "depth 17", depth: 16, accepted: false },
  ])("enforces $name on both boundaries", async ({ depth, accepted }) => {
    await assertParity(
      withFuture(`${"[".repeat(depth)}0${"]".repeat(depth)}`),
      accepted,
    );
  });

  it.each([
    { entries: 256, accepted: true },
    { entries: 257, accepted: false },
  ])(
    "enforces $entries entries per container",
    async ({ entries, accepted }) => {
      await assertParity(
        withFuture(JSON.stringify(Array.from({ length: entries }, () => null))),
        accepted,
      );
      resetProvidersResponseCacheForTests();
      vi.restoreAllMocks();
      await assertParity(
        withFuture(
          JSON.stringify(
            Object.fromEntries(
              Array.from({ length: entries }, (_, index) => [
                `field${index}`,
                null,
              ]),
            ),
          ),
        ),
        accepted,
      );
    },
  );

  it.each([
    { nodes: 2_048, tailEntries: 236, accepted: true },
    { nodes: 2_049, tailEntries: 237, accepted: false },
  ])("enforces $nodes parsed values", async ({ tailEntries, accepted }) => {
    // The flat contract has 11 values. The extension adds one outer array,
    // eight inner arrays, and 7 * 256 + tailEntries primitive values.
    const extension = [
      ...Array.from({ length: 7 }, () =>
        Array.from({ length: 256 }, () => null),
      ),
      Array.from({ length: tailEntries }, () => null),
    ];
    await assertParity(withFuture(JSON.stringify(extension)), accepted);
  });

  it.each([
    { bytes: 65_536, accepted: true },
    { bytes: 65_537, accepted: false },
  ])("enforces $bytes response bytes", async ({ bytes, accepted }) => {
    const emptyBodyBytes = encoder.encode(withFuture('""')).byteLength;
    await assertParity(
      withFuture(JSON.stringify("a".repeat(bytes - emptyBodyBytes))),
      accepted,
    );
  });
});
