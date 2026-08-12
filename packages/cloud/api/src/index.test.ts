/** Verifies Cloud Worker routing and thin-inference dispatch with deterministic fixtures. */
import { beforeEach, describe, expect, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import cloudApiWorker, {
  getFrontendAliasApiProxyTarget,
  getFrontendAliasProxyTarget,
  getHostedFrontendServeRewrite,
  isCanonicalInferencePath,
  isThinInferenceEnabled,
  isThinStewardPublicPath,
  redirectFrontendHost,
  SharedRuntimeConversation,
} from "./index";
import { resetProvidersResponseCacheForTests } from "./steward/embedded";

test("exports the shared-runtime conversation Durable Object", () => {
  expect(typeof SharedRuntimeConversation).toBe("function");
});

describe("thin inference entry dispatch", () => {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  const thinInferenceEnv = {
    ENVIRONMENT: "test",
    NODE_ENV: "test",
    REDIS_RATE_LIMITING: "false",
    CACHE_ENABLED: "false",
    THIN_INFERENCE_ENTRY_ENABLED: "true",
    BLOB: {},
  } as unknown as AppEnv["Bindings"];

  test("is rollback-safe and disabled unless explicitly true", () => {
    expect(isThinInferenceEnabled({})).toBe(false);
    expect(
      isThinInferenceEnabled({ THIN_INFERENCE_ENTRY_ENABLED: "false" }),
    ).toBe(false);
    expect(
      isThinInferenceEnabled({ THIN_INFERENCE_ENTRY_ENABLED: "true" }),
    ).toBe(true);
  });

  test("matches canonical generative routes without accepting suffixes", () => {
    expect(isCanonicalInferencePath("/api/v1/chat/completions")).toBe(true);
    expect(isCanonicalInferencePath("/api/v1/chat/completions/")).toBe(false);
    expect(isCanonicalInferencePath("/api/v1/chat/completions/admin")).toBe(
      false,
    );
    expect(isCanonicalInferencePath("/api/v1/embeddings")).toBe(true);
    expect(isCanonicalInferencePath("/api/v1/messages")).toBe(true);
    expect(isCanonicalInferencePath("/api/v1/voice/stt")).toBe(true);
    expect(isCanonicalInferencePath("/api/v1/voice/tts")).toBe(true);
    expect(isCanonicalInferencePath("/api/v1/generate-image")).toBe(true);
    expect(isCanonicalInferencePath("/api/v1/apps/app-1/chat")).toBe(true);
    expect(isCanonicalInferencePath("/api/agents/agent-1/a2a")).toBe(true);
    expect(isCanonicalInferencePath("/api/v1/models")).toBe(false);
  });

  test("dispatches canonical chat requests through the thin app when enabled", async () => {
    const response = await cloudApiWorker.fetch(
      new Request("https://api.elizacloud.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemma-4-31b",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      thinInferenceEnv,
      executionCtx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("x-eliza-inference-path")).toBe("thin");
    expect(response.headers.get("server-timing")).toContain("entry_dispatch");
  });

  test("dispatches OpenAI-compatible chat rewrites through the thin app", async () => {
    const response = await cloudApiWorker.fetch(
      new Request("https://api.elizacloud.ai/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemma-4-31b",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      thinInferenceEnv,
      executionCtx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("x-eliza-inference-path")).toBe("thin");
  });
});

describe("thin Steward public path dispatch (#18049)", () => {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  const stewardEnv = {
    ENVIRONMENT: "test",
    NODE_ENV: "test",
    ELIZA_DEPLOY_COMMIT: "test-commit-18049",
    STEWARD_API_URL: "https://steward.example.test",
    STEWARD_TENANT_ID: "elizacloud-staging",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
  } as unknown as AppEnv["Bindings"];

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetProvidersResponseCacheForTests();
  });

  test("matches only login-critical Steward GETs", () => {
    expect(isThinStewardPublicPath("/steward/auth/providers")).toBe(true);
    expect(isThinStewardPublicPath("/steward/auth/providers/")).toBe(true);
    expect(isThinStewardPublicPath("/steward/tenants/config")).toBe(true);
    expect(isThinStewardPublicPath("/steward/auth/email/send")).toBe(false);
    expect(isThinStewardPublicPath("/steward/auth/nonce")).toBe(false);
    expect(isThinStewardPublicPath("/api/v1/oauth/providers")).toBe(false);
  });

  test("dispatches GET /steward/auth/providers through the thin shell", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      expect(url).toBe("https://steward.example.test/auth/providers");
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
        },
      });
    }) as typeof fetch;

    try {
      const response = await cloudApiWorker.fetch(
        new Request("https://api.elizacloud.ai/steward/auth/providers", {
          method: "GET",
          headers: { origin: "https://app.elizacloud.ai" },
        }),
        stewardEnv,
        executionCtx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-eliza-steward-path")).toBe("thin");
      expect(response.headers.get("server-timing")).toContain("entry_dispatch");
      expect(response.headers.get("x-eliza-providers-cache")).toBe("miss");

      const body = (await response.json()) as {
        ok?: boolean;
        data?: { google?: boolean; passkey?: boolean };
      };
      expect(body.ok).toBe(true);
      expect(body.data?.passkey).toBe(true);
      // Env OAuth creds patch google even when Steward reports false.
      expect(body.data?.google).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("serves GET /steward/tenants/config from the thin shell without upstream", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return new Response("should-not-be-called", { status: 500 });
    }) as typeof fetch;

    try {
      const response = await cloudApiWorker.fetch(
        new Request("https://api.elizacloud.ai/steward/tenants/config", {
          method: "GET",
        }),
        stewardEnv,
        executionCtx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-eliza-steward-path")).toBe("thin");
      expect(upstreamCalls).toBe(0);
      const body = (await response.json()) as {
        ok?: boolean;
        data?: { features?: { enableSolana?: boolean } };
      };
      expect(body.ok).toBe(true);
      expect(body.data?.features?.enableSolana).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reuses isolate providers cache on the second GET", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        ok: true,
        data: {
          passkey: true,
          email: true,
          google: false,
          oauth: [],
        },
      });
    }) as typeof fetch;

    try {
      const first = await cloudApiWorker.fetch(
        new Request("https://api.elizacloud.ai/steward/auth/providers"),
        stewardEnv,
        executionCtx,
      );
      const second = await cloudApiWorker.fetch(
        new Request("https://api.elizacloud.ai/steward/auth/providers"),
        stewardEnv,
        executionCtx,
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.headers.get("x-eliza-providers-cache")).toBe("miss");
      expect(second.headers.get("x-eliza-providers-cache")).toBe("hit");
      expect(upstreamCalls).toBe(1);
      expect(second.headers.get("x-eliza-steward-path")).toBe("thin");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("getHostedFrontendServeRewrite (managed frontend hosting)", () => {
  const env = { ELIZA_FRONTEND_HOST_SUFFIX: "sites.elizacloud.ai" };

  test("is a no-op when the suffix env is unset (opt-in)", () => {
    expect(
      getHostedFrontendServeRewrite(
        new URL("https://acme.sites.elizacloud.ai/"),
        {},
      ),
    ).toBeNull();
  });

  test("rewrites a system-host page request to the internal serve route", () => {
    const out = getHostedFrontendServeRewrite(
      new URL("https://acme.sites.elizacloud.ai/dashboard"),
      env,
    );
    expect(out?.pathname).toBe("/api/v1/hosted-frontend/serve/dashboard");
    expect(out?.searchParams.get("host")).toBe("acme.sites.elizacloud.ai");
  });

  test("rewrites the root path", () => {
    const out = getHostedFrontendServeRewrite(
      new URL("https://acme.sites.elizacloud.ai/"),
      env,
    );
    expect(out?.pathname).toBe("/api/v1/hosted-frontend/serve");
  });

  test("does NOT rewrite /api or /steward on a system host (beacon + APIs work)", () => {
    expect(
      getHostedFrontendServeRewrite(
        new URL("https://acme.sites.elizacloud.ai/api/v1/track/pageview"),
        env,
      ),
    ).toBeNull();
    expect(
      getHostedFrontendServeRewrite(
        new URL("https://acme.sites.elizacloud.ai/steward"),
        env,
      ),
    ).toBeNull();
  });

  test("ignores hosts that are not under the suffix, and nested subdomains", () => {
    expect(
      getHostedFrontendServeRewrite(new URL("https://elizacloud.ai/"), env),
    ).toBeNull();
    expect(
      getHostedFrontendServeRewrite(
        new URL("https://a.b.sites.elizacloud.ai/"),
        env,
      ),
    ).toBeNull();
  });
});

describe("cloud-api worker entrypoint", () => {
  test("redirects www frontend host to apex without dropping path or query", () => {
    const response = redirectFrontendHost(
      new URL(
        "https://www.elizacloud.ai/dashboard/agents/e06bb509-6c52-4c33-a9f7-66addc43e8c8?tab=chat",
      ),
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe(
      "https://elizacloud.ai/dashboard/agents/e06bb509-6c52-4c33-a9f7-66addc43e8c8?tab=chat",
    );
  });

  test("does NOT redirect app.* — it serves the Eliza agent app (D5 topology split)", () => {
    // Under D5, app.elizacloud.ai is the `eliza-app` Pages project, not the
    // apex console. The Worker must not 308 it to the apex.
    expect(
      redirectFrontendHost(
        new URL("https://app.elizacloud.ai/login?next=%2Fdashboard"),
        { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
      ),
    ).toBeNull();
  });

  test("does not redirect the apex or the api host", () => {
    expect(
      redirectFrontendHost(new URL("https://elizacloud.ai/login"), {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
      }),
    ).toBeNull();
    expect(
      redirectFrontendHost(new URL("https://api.elizacloud.ai/api/health"), {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
      }),
    ).toBeNull();
  });

  test("does not redirect generated agent subdomains", () => {
    const response = redirectFrontendHost(
      new URL("https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/"),
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" },
    );

    expect(response).toBeNull();
  });

  test("proxies staging frontend aliases to the Pages develop branch", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://staging.elizacloud.ai/dashboard?tab=agents"),
    );

    expect(target?.toString()).toBe(
      "https://develop.eliza-cloud-enq.pages.dev/dashboard?tab=agents",
    );
  });

  test("proxies app frontend aliases to the app Pages project", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://app.elizacloud.ai/?runtime=first-run"),
    );

    expect(target?.toString()).toBe(
      "https://eliza-app.pages.dev/?runtime=first-run",
    );
  });

  test("proxies staging app frontend aliases to the app Pages develop branch", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://app-staging.elizacloud.ai/?runtime=first-run"),
    );

    expect(target?.toString()).toBe(
      "https://develop.eliza-app.pages.dev/?runtime=first-run",
    );
  });

  test("proxies staging API aliases to the staging API worker", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://staging.elizacloud.ai/api/health"),
    );

    expect(target?.toString()).toBe(
      "https://api-staging.elizacloud.ai/api/health",
    );
  });

  test("proxies staging app API aliases to the staging API worker", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://app-staging.elizacloud.ai/api/health"),
    );

    expect(target?.toString()).toBe(
      "https://api-staging.elizacloud.ai/api/health",
    );
  });

  test("exposes frontend alias API targets for in-process handling", () => {
    const target = getFrontendAliasApiProxyTarget(
      new URL("https://app-staging.elizacloud.ai/api/status"),
    );

    expect(target?.toString()).toBe(
      "https://api-staging.elizacloud.ai/api/status",
    );
  });

  test("handles app-staging API health in-process without external proxying", async () => {
    const originalFetch = globalThis.fetch;
    let didProxyExternally = false;

    globalThis.fetch = (() => {
      didProxyExternally = true;
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;

    try {
      const response = await cloudApiWorker.fetch(
        new Request("https://app-staging.elizacloud.ai/api/health", {
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            "cf-ray": "test-ray",
            host: "app-staging.elizacloud.ai",
          },
        }),
        {} as never,
        {} as never,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok" });
      expect(didProxyExternally).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("includes the deploy commit in API health for stale-run deploy guards", async () => {
    const response = await cloudApiWorker.fetch(
      new Request("https://api-staging.elizacloud.ai/api/health", {
        headers: {
          host: "api-staging.elizacloud.ai",
        },
      }),
      {
        CF_REGION: "local-test",
        ELIZA_DEPLOY_COMMIT: "feedfacefeedfacefeedfacefeedfacefeedface",
      } as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      region: "local-test",
      commit: "feedfacefeedfacefeedfacefeedfacefeedface",
    });
  });

  test("reports only value-free staging session cutover readiness", async () => {
    const response = await cloudApiWorker.fetch(
      new Request("https://api-staging.elizacloud.ai/api/health", {
        headers: { host: "api-staging.elizacloud.ai" },
      }),
      {
        NODE_ENV: "production",
        ENVIRONMENT: "staging",
        ELIZA_DEPLOY_COMMIT: "cutover-commit",
        STAGING_SESSION_EXCHANGE_ENABLED: "true",
        STAGING_SESSION_EXCHANGE_VERSION: "v1",
        STAGING_SESSION_EXCHANGE_SIGNING_SECRET:
          "never-return-this-secret-0123456789abcdef",
        ELIZA_SERVICE_JWT_SECRET:
          "separate-service-bridge-secret-0123456789abcdef",
        STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "staging-qa-v1-test",
        STEWARD_TENANT_ID: "staging-tenant",
        STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS:
          "33333333-3333-4333-8333-333333333333",
        STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS:
          "11111111-1111-4111-8111-111111111111",
        STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS:
          "22222222-2222-4222-8222-222222222222",
      } as never,
      {} as never,
    );

    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      commit: "cutover-commit",
      environment: "staging",
      stagingSessionExchange: {
        enabled: true,
        ready: true,
        version: "v1",
      },
    });
    expect(text).not.toContain("never-return-this-secret");
    expect(text).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(text).not.toContain("staging-qa-v1-test");

    const malformedResponse = await cloudApiWorker.fetch(
      new Request("https://api-staging.elizacloud.ai/api/health", {
        headers: { host: "api-staging.elizacloud.ai" },
      }),
      {
        NODE_ENV: "production",
        ENVIRONMENT: "staging",
        STAGING_SESSION_EXCHANGE_ENABLED: "true",
        STAGING_SESSION_EXCHANGE_VERSION: "v1",
        STAGING_SESSION_EXCHANGE_SIGNING_SECRET:
          "never-return-this-secret-0123456789abcdef",
        STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "staging-qa-v1-test",
        STEWARD_TENANT_ID: "staging-tenant",
        STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS:
          "33333333-3333-4333-8333-333333333333",
        STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS: "not-a-uuid",
        STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS:
          "22222222-2222-4222-8222-222222222222",
      } as never,
      {} as never,
    );
    expect(await malformedResponse.json()).toMatchObject({
      stagingSessionExchange: { enabled: true, ready: false, version: "v1" },
    });

    const serviceCollisionResponse = await cloudApiWorker.fetch(
      new Request("https://api-staging.elizacloud.ai/api/health", {
        headers: { host: "api-staging.elizacloud.ai" },
      }),
      {
        NODE_ENV: "production",
        ENVIRONMENT: "staging",
        STAGING_SESSION_EXCHANGE_ENABLED: "true",
        STAGING_SESSION_EXCHANGE_VERSION: "v1",
        STAGING_SESSION_EXCHANGE_SIGNING_SECRET:
          "colliding-service-secret-0123456789abcdef",
        ELIZA_SERVICE_JWT_SECRET: "colliding-service-secret-0123456789abcdef",
        STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "staging-qa-v1-test",
        STEWARD_TENANT_ID: "staging-tenant",
        STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS:
          "33333333-3333-4333-8333-333333333333",
        STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS:
          "11111111-1111-4111-8111-111111111111",
        STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS:
          "22222222-2222-4222-8222-222222222222",
      } as never,
      {} as never,
    );
    expect(await serviceCollisionResponse.json()).toMatchObject({
      stagingSessionExchange: { enabled: true, ready: false, version: "v1" },
    });
  });

  test("routes app-staging custom domain to the staging Worker", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as {
      env?: {
        staging?: {
          routes?: Array<{ pattern?: string }>;
        };
      };
    };

    const stagingRoutes =
      config.env?.staging?.routes?.map((route) => route.pattern) ?? [];

    expect(stagingRoutes).toContain("app-staging.elizacloud.ai/*");
  });

  test("binds the global native limiter in every Worker environment and keeps inference routes gate-free", async () => {
    type RateLimitBinding = {
      name?: string;
      simple?: { limit?: number; period?: number };
    };
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as {
      ratelimits?: RateLimitBinding[];
      env?: {
        staging?: { ratelimits?: RateLimitBinding[] };
        production?: { ratelimits?: RateLimitBinding[] };
      };
    };
    for (const bindings of [
      config.ratelimits,
      config.env?.staging?.ratelimits,
      config.env?.production?.ratelimits,
    ]) {
      expect(bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "GLOBAL_RATE_LIMITER",
            simple: { limit: 600, period: 60 },
          }),
        ]),
      );
    }

    // #17805 retired the per-route native gates from the generative hot path:
    // rate policy rides the IAC v2 admission snapshot through the org-level
    // limiter. The inference route sources must stay free of per-route native
    // bindings, while both Worker app builders keep the global gate.
    const [
      chat,
      completions,
      messages,
      embeddings,
      bootstrapApp,
      inferenceApp,
    ] = await Promise.all([
      Bun.file(new URL("../v1/chat/route.ts", import.meta.url)).text(),
      Bun.file(
        new URL("../v1/chat/completions/route.ts", import.meta.url),
      ).text(),
      Bun.file(new URL("../v1/messages/route.ts", import.meta.url)).text(),
      Bun.file(new URL("../v1/embeddings/route.ts", import.meta.url)).text(),
      Bun.file(new URL("./bootstrap-app.ts", import.meta.url)).text(),
      Bun.file(new URL("./inference-app.ts", import.meta.url)).text(),
    ]);
    for (const source of [chat, completions, messages, embeddings]) {
      expect(source).not.toContain("bindingName:");
    }
    expect(bootstrapApp).toContain('bindingName: "GLOBAL_RATE_LIMITER"');
    expect(inferenceApp).toContain('bindingName: "GLOBAL_RATE_LIMITER"');
  });
});
