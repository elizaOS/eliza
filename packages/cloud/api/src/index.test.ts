/** Verifies Cloud Worker routing and thin-inference dispatch with deterministic fixtures. */
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import cloudApiWorker, {
  getFrontendAliasApiProxyTarget,
  getFrontendAliasProxyTarget,
  getHostedFrontendServeRewrite,
  isCanonicalInferencePath,
  isThinInferenceEnabled,
  redirectFrontendHost,
  SharedRuntimeConversation,
} from "./index";

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
