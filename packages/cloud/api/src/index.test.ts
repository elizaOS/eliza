// Exercises cloud API src index.test behavior with deterministic Worker route fixtures.
import { describe, expect, test } from "bun:test";
import cloudApiWorker, {
  getFrontendAliasApiProxyTarget,
  getFrontendAliasProxyTarget,
  getFrontendAliasSyntheticResponse,
  getHostedFrontendServeRewrite,
  redirectFrontendHost,
} from "./index";

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

  test("feed.elizacloud.ai is inert when FEED_ORIGIN_HOST is unset", () => {
    // No env / empty host => falls through to the cloud-api app (no regression).
    expect(
      getFrontendAliasProxyTarget(new URL("https://feed.elizacloud.ai/feed")),
    ).toBeNull();
    expect(
      getFrontendAliasProxyTarget(new URL("https://feed.elizacloud.ai/feed"), {
        FEED_ORIGIN_HOST: "",
      }),
    ).toBeNull();
  });

  test("proxies feed.elizacloud.ai pages to the Railway origin when configured", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://feed.elizacloud.ai/markets?marketKind=prediction"),
      { FEED_ORIGIN_HOST: "feed-web-production.up.railway.app" },
    );

    expect(target?.toString()).toBe(
      "https://feed-web-production.up.railway.app/markets?marketKind=prediction",
    );
  });

  test("accepts a full feed origin URL and preserves an explicit port", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://feed.elizacloud.ai/markets"),
      { FEED_ORIGIN_HOST: "https://feed-web-production.up.railway.app:8443" },
    );

    expect(target?.toString()).toBe(
      "https://feed-web-production.up.railway.app:8443/markets",
    );
  });

  test("rejects pathful feed origin configuration instead of proxying broadly", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://feed.elizacloud.ai/markets"),
      {
        FEED_ORIGIN_HOST:
          "https://feed-web-production.up.railway.app/feed-prefix",
      },
    );

    expect(target).toBeNull();
  });

  test("proxies feed /api/* to the SAME Railway origin (single origin, no app/api split)", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://feed.elizacloud.ai/api/health"),
      { FEED_ORIGIN_HOST: "feed-web-production.up.railway.app" },
    );

    expect(target?.toString()).toBe(
      "https://feed-web-production.up.railway.app/api/health",
    );
  });

  test("sanitizes spoofable forwarded IP headers before proxying feed", async () => {
    const originalFetch = globalThis.fetch;
    const proxiedRequests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      proxiedRequests.push(request);
      return new Response("ok");
    }) as typeof fetch;

    try {
      const response = await cloudApiWorker.fetch(
        new Request("https://feed.elizacloud.ai/api/health", {
          headers: {
            "cf-connecting-ip": "203.0.113.10",
            forwarded: "for=198.51.100.1",
            host: "feed.elizacloud.ai",
            "x-forwarded-for": "198.51.100.2",
            "x-real-ip": "198.51.100.3",
          },
        }),
        { FEED_ORIGIN_HOST: "feed-web-production.up.railway.app" } as never,
        {} as ExecutionContext,
      );

      expect(response.status).toBe(200);
      expect(proxiedRequests).toHaveLength(1);
      const proxied = proxiedRequests[0];
      expect(proxied.url).toBe(
        "https://feed-web-production.up.railway.app/api/health",
      );
      expect(proxied.headers.get("forwarded")).toBeNull();
      expect(proxied.headers.get("host")).toBeNull();
      expect(proxied.headers.get("x-forwarded-for")).toBe("203.0.113.10");
      expect(proxied.headers.get("x-real-ip")).toBe("203.0.113.10");
      expect(proxied.headers.get("x-forwarded-host")).toBe(
        "feed.elizacloud.ai",
      );
      expect(proxied.headers.get("x-forwarded-proto")).toBe("https");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("serves empty Feed observability scripts instead of proxying Vercel-only 404s", async () => {
    const response = getFrontendAliasSyntheticResponse(
      new URL("https://feed.elizacloud.ai/_vercel/insights/script.js"),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain(
      "application/javascript",
    );
    expect(await response?.text()).toBe("");
  });

  test("redirects missing Feed preset PFP assets to the bundled fallback image", () => {
    const response = getFrontendAliasSyntheticResponse(
      new URL("https://feed.elizacloud.ai/assets/user-pfps/pfp-041.png"),
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      "https://feed.elizacloud.ai/blankmonkey.png",
    );
  });

  test("does not synthesize responses for non-Feed aliases", () => {
    expect(
      getFrontendAliasSyntheticResponse(
        new URL("https://staging.elizacloud.ai/_vercel/insights/script.js"),
      ),
    ).toBeNull();
  });
});
