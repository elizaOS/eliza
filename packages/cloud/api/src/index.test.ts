/** Verifies Cloud Worker routing and thin-inference dispatch with deterministic fixtures. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import cloudApiWorker, {
  decorateFullAppDispatchResponse,
  getFrontendAliasApiProxyTarget,
  getFrontendAliasProxyTarget,
  getGeneratedAgentId,
  getHostedFrontendServeRewrite,
  isCanonicalInferencePath,
  isElizaAppWebhookPath,
  isInternalDiscordGatewayPath,
  isThinInferenceEnabled,
  isThinStewardEmailAuthPath,
  isThinStewardPath,
  isThinStewardPublicPath,
  isUnsupportedLegacyWildcardHostname,
  redirectFrontendHost,
  SharedRuntimeConversation,
  TwitterOAuthRefreshCoordinator,
} from "./index";
import { resetProvidersResponseCacheForTests } from "./steward/embedded";

test("exports the shared-runtime conversation Durable Object", () => {
  expect(typeof SharedRuntimeConversation).toBe("function");
});

test("exports the X OAuth refresh Durable Object", () => {
  expect(typeof TwitterOAuthRefreshCoordinator).toBe("function");
});

test("preserves Workerd WebSocket upgrade responses without rewrapping", () => {
  const upgrade = {
    status: 101,
    webSocket: { accepted: true },
  } as unknown as Response;

  expect(
    decorateFullAppDispatchResponse(
      upgrade,
      "11111111-1111-4111-8111-111111111111",
      12,
      8,
    ),
  ).toBe(upgrade);
});

test("dispatches provider webhooks without full-app bootstrap", async () => {
  const traceId = "11111111-1111-4111-8111-111111111111";
  const env = {
    ENVIRONMENT: "test",
    NODE_ENV: "test",
    REDIS_RATE_LIMITING: "false",
    CACHE_ENABLED: "false",
    THIN_INFERENCE_ENTRY_ENABLED: "false",
    BLOB: {},
  } as unknown as AppEnv["Bindings"];
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const makeRequest = () =>
    new Request("https://api.eliza.app/api/eliza-app/webhook/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eliza-trace-id": traceId,
      },
      body: "{}",
    });

  const response = await cloudApiWorker.fetch(makeRequest(), env, executionCtx);

  expect(response.status).toBe(503);
  expect(response.headers.get("x-eliza-trace-id")).toBe(traceId);
  expect(response.headers.get("x-eliza-webhook-path")).toBe("thin");
  expect(response.headers.get("server-timing")).toMatch(
    /webhook_entry_dispatch;dur=\d+(?:\.\d+)?/,
  );
  expect(response.headers.get("server-timing")).toMatch(
    /webhook_module_init;dur=\d+(?:\.\d+)?/,
  );
  expect(response.headers.get("server-timing")).not.toContain(
    "full_app_dispatch",
  );

  const warmResponse = await cloudApiWorker.fetch(
    makeRequest(),
    env,
    executionCtx,
  );
  expect(warmResponse.headers.get("server-timing")).toContain(
    "webhook_entry_dispatch",
  );
  expect(warmResponse.headers.get("server-timing")).not.toContain(
    "webhook_module_init",
  );
});

test("matches only supported provider webhook routes", () => {
  expect(isElizaAppWebhookPath("/api/eliza-app/webhook/telegram")).toBe(true);
  expect(isElizaAppWebhookPath("/api/eliza-app/webhook/telegram/agent-1")).toBe(
    true,
  );
  expect(isElizaAppWebhookPath("/api/eliza-app/webhook/whatsapp/")).toBe(true);
  expect(isElizaAppWebhookPath("/api/eliza-app/webhook/telegram-admin")).toBe(
    false,
  );
  expect(isElizaAppWebhookPath("/api/eliza-app/webhook/unknown")).toBe(false);
  expect(isElizaAppWebhookPath("/api/eliza-app/webhook")).toBe(false);
});

test("matches only the managed Discord gateway route", () => {
  expect(
    isInternalDiscordGatewayPath("/api/internal/discord/eliza-app/messages"),
  ).toBe(true);
  expect(
    isInternalDiscordGatewayPath("/api/internal/discord/eliza-app/messages/"),
  ).toBe(false);
  expect(
    isInternalDiscordGatewayPath(
      "/api/internal/discord/eliza-app/messages/admin",
    ),
  ).toBe(false);
});

test("dispatches managed Discord turns without full-app bootstrap", async () => {
  const traceId = "33333333-3333-4333-8333-333333333333";
  const env = {
    ENVIRONMENT: "test",
    NODE_ENV: "test",
    REDIS_RATE_LIMITING: "false",
    CACHE_ENABLED: "false",
    THIN_INFERENCE_ENTRY_ENABLED: "false",
    BLOB: {},
  } as unknown as AppEnv["Bindings"];
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const makeRequest = () =>
    new Request(
      "https://api.eliza.app/api/internal/discord/eliza-app/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-eliza-trace-id": traceId,
        },
        body: "{}",
      },
    );

  const response = await cloudApiWorker.fetch(makeRequest(), env, executionCtx);

  expect(response.status).toBe(401);
  expect(response.headers.get("x-eliza-trace-id")).toBe(traceId);
  expect(response.headers.get("x-eliza-discord-path")).toBe("thin");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("server-timing")).toMatch(
    /discord_entry_dispatch;dur=\d+(?:\.\d+)?/,
  );
  expect(response.headers.get("server-timing")).toMatch(
    /discord_module_init;dur=\d+(?:\.\d+)?/,
  );
  expect(response.headers.get("server-timing")).not.toContain(
    "full_app_dispatch",
  );

  const warmResponse = await cloudApiWorker.fetch(
    makeRequest(),
    env,
    executionCtx,
  );
  expect(warmResponse.status).toBe(401);
  expect(warmResponse.headers.get("server-timing")).toContain(
    "discord_entry_dispatch",
  );
  expect(warmResponse.headers.get("server-timing")).not.toContain(
    "discord_module_init",
  );
});

test("preserves provider authentication on the thin webhook path", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamFetch = mock(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
  );
  globalThis.fetch = upstreamFetch as unknown as typeof fetch;
  const env = {
    ENVIRONMENT: "test",
    NODE_ENV: "test",
    REDIS_RATE_LIMITING: "false",
    CACHE_ENABLED: "false",
    ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.example.test",
    ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "telegram-secret",
    ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "gateway-secret",
    BLOB: {},
  } as unknown as AppEnv["Bindings"];
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const request = (secret: string) =>
    new Request("https://api.eliza.app/api/eliza-app/webhook/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: "{}",
    });

  try {
    const accepted = await cloudApiWorker.fetch(
      request("telegram-secret"),
      env,
      executionCtx,
    );
    const rejected = await cloudApiWorker.fetch(
      request("wrong-secret"),
      env,
      executionCtx,
    );

    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("x-eliza-webhook-path")).toBe("thin");
    expect(rejected.status).toBe(401);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const forwardedHeaders = new Headers(
      upstreamFetch.mock.calls[0]?.[1]?.headers,
    );
    expect(forwardedHeaders.get("x-eliza-webhook-forwarder-secret")).toBe(
      "gateway-secret",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("correlates and times dispatch outside full-app middleware", async () => {
  const traceId = "22222222-2222-4222-8222-222222222222";
  const env = {
    ENVIRONMENT: "test",
    NODE_ENV: "test",
    REDIS_RATE_LIMITING: "false",
    CACHE_ENABLED: "false",
    THIN_INFERENCE_ENTRY_ENABLED: "false",
    BLOB: {},
  } as unknown as AppEnv["Bindings"];
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const makeRequest = () =>
    new Request("https://api.eliza.app/api/full-app-telemetry-fixture", {
      headers: { "x-eliza-trace-id": traceId },
    });

  const response = await cloudApiWorker.fetch(makeRequest(), env, executionCtx);

  expect(response.status).toBe(401);
  expect(response.headers.get("x-eliza-trace-id")).toBe(traceId);
  expect(response.headers.get("server-timing")).toMatch(
    /full_app_dispatch;dur=\d+(?:\.\d+)?/,
  );
  expect(response.headers.get("server-timing")).toMatch(
    /full_app_module_init;dur=\d+(?:\.\d+)?/,
  );
  expect(response.headers.get("server-timing")).toContain(
    'full_app_isolate;dur=0;desc="cold"',
  );

  const warmResponse = await cloudApiWorker.fetch(
    makeRequest(),
    env,
    executionCtx,
  );
  expect(warmResponse.headers.get("server-timing")).toContain(
    "full_app_dispatch",
  );
  expect(warmResponse.headers.get("server-timing")).not.toContain(
    "full_app_module_init",
  );
  expect(warmResponse.headers.get("server-timing")).toContain(
    'full_app_isolate;dur=0;desc="warm"',
  );
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
      new Request("https://api.eliza.app/api/v1/chat/completions", {
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
      new Request("https://api.eliza.app/chat/completions", {
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
    REDIS_RATE_LIMITING: "false",
    BLOB: {},
  } as unknown as AppEnv["Bindings"];

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetProvidersResponseCacheForTests();
    globalThis.fetch = originalFetch;
  });

  test("matches only login-critical Steward GETs", () => {
    expect(isThinStewardPublicPath("/steward/auth/providers")).toBe(true);
    expect(isThinStewardPublicPath("/steward/auth/providers/")).toBe(true);
    expect(isThinStewardPublicPath("/steward/tenants/config")).toBe(true);
    expect(isThinStewardPublicPath("/steward/auth/email/send")).toBe(false);
    expect(isThinStewardPublicPath("/steward/auth/nonce")).toBe(false);
    expect(isThinStewardPublicPath("/api/v1/oauth/providers")).toBe(false);
  });

  test("POST Magic Link email legs are thin-eligible; other mutations are not", () => {
    expect(isThinStewardEmailAuthPath("/steward/auth/email/send")).toBe(true);
    expect(isThinStewardEmailAuthPath("/steward/auth/email/code/verify")).toBe(
      true,
    );
    expect(isThinStewardEmailAuthPath("/steward/auth/email/status")).toBe(true);
    expect(isThinStewardEmailAuthPath("/steward/vault/keys")).toBe(false);
    expect(isThinStewardPath("POST", "/steward/auth/email/send")).toBe(true);
    expect(isThinStewardPath("POST", "/steward/auth/providers")).toBe(false);
    expect(isThinStewardPath("GET", "/steward/auth/email/send")).toBe(false);
    expect(isThinStewardPath("DELETE", "/steward/auth/email/send")).toBe(false);
    expect(isThinStewardPath("OPTIONS", "/steward/auth/email/send")).toBe(true);
  });

  test("dispatches POST /steward/auth/email/send through the thin shell", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      expect(url).toBe("https://steward.example.test/auth/email/send");
      return Response.json({
        ok: true,
        data: {
          expiresAt: "2026-01-01T00:00:00.000Z",
          challengeId: "c1",
          pollSecret: "p1",
        },
      });
    }) as unknown as typeof fetch;

    try {
      const response = await cloudApiWorker.fetch(
        new Request("https://api.eliza.app/steward/auth/email/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://cloud.eliza.app",
          },
          body: JSON.stringify({ email: "user@example.com" }),
        }),
        stewardEnv,
        executionCtx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-eliza-steward-path")).toBe("thin");
      const body = (await response.json()) as {
        ok?: boolean;
        data?: { challengeId?: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data?.challengeId).toBe("c1");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    }) as unknown as typeof fetch;

    try {
      const response = await cloudApiWorker.fetch(
        new Request("https://api.eliza.app/steward/auth/providers", {
          method: "GET",
          headers: { origin: "https://cloud.eliza.app" },
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
    }) as unknown as typeof fetch;

    try {
      const response = await cloudApiWorker.fetch(
        new Request("https://api.eliza.app/steward/tenants/config", {
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
    }) as unknown as typeof fetch;

    try {
      const first = await cloudApiWorker.fetch(
        new Request("https://api.eliza.app/steward/auth/providers"),
        stewardEnv,
        executionCtx,
      );
      const second = await cloudApiWorker.fetch(
        new Request("https://api.eliza.app/steward/auth/providers"),
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
  const env = { ELIZA_FRONTEND_HOST_SUFFIX: "sites.eliza.app" };

  test("is a no-op when the suffix env is unset (opt-in)", () => {
    expect(
      getHostedFrontendServeRewrite(
        new URL("https://acme.sites.eliza.app/"),
        {},
      ),
    ).toBeNull();
  });

  test("rewrites a system-host page request to the internal serve route", () => {
    const out = getHostedFrontendServeRewrite(
      new URL("https://acme.sites.eliza.app/dashboard"),
      env,
    );
    expect(out?.pathname).toBe("/api/v1/hosted-frontend/serve/dashboard");
    // The hostname is preserved in the rewritten URL and is the serve route's
    // only trusted host source; no `?host=` override is attached.
    expect(out?.hostname).toBe("acme.sites.eliza.app");
    expect(out?.searchParams.get("host")).toBeNull();
  });

  test("rewrites the root path", () => {
    const out = getHostedFrontendServeRewrite(
      new URL("https://acme.sites.eliza.app/"),
      env,
    );
    expect(out?.pathname).toBe("/api/v1/hosted-frontend/serve");
  });

  test("does NOT rewrite /api or /steward on a system host (beacon + APIs work)", () => {
    expect(
      getHostedFrontendServeRewrite(
        new URL("https://acme.sites.eliza.app/api/v1/track/pageview"),
        env,
      ),
    ).toBeNull();
    expect(
      getHostedFrontendServeRewrite(
        new URL("https://acme.sites.eliza.app/steward"),
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
        new URL("https://a.b.sites.eliza.app/"),
        env,
      ),
    ).toBeNull();
  });
});

describe("cloud-api worker entrypoint", () => {
  test("redirects the canonical www host to the marketing apex", () => {
    const response = redirectFrontendHost(
      new URL("https://www.eliza.app/downloads?platform=mac#install"),
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app" },
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe(
      "https://eliza.app/downloads?platform=mac#install",
    );
  });

  test("redirects every legacy browser and API role to its canonical host", () => {
    const cases = [
      [
        "https://elizacloud.ai/dashboard?tab=agents#active",
        "https://cloud.eliza.app/cloud?tab=agents#active",
      ],
      [
        "https://www.elizacloud.ai/downloads?platform=mac",
        "https://eliza.app/downloads?platform=mac",
      ],
      [
        "https://app.elizacloud.ai/login?next=%2Fdashboard",
        "https://cloud.eliza.app/login?next=%2Fdashboard",
      ],
      [
        "https://app.elizacloud.ai/dashboard/billing?from=legacy",
        "https://cloud.eliza.app/cloud/billing?from=legacy",
      ],
      [
        "https://app.elizacloud.ai/dashboard/image?from=legacy",
        "https://cloud.eliza.app/cloud/api-explorer?from=legacy",
      ],
      [
        "https://elizacloud.ai/dashboard/build/new?template=starter",
        "https://cloud.eliza.app/cloud/my-agents?template=starter",
      ],
      [
        "https://app.elizacloud.ai/dashboard/containers/agents/agent-7",
        "https://cloud.eliza.app/cloud/agents/agent-7",
      ],
      [
        "https://app-staging.elizacloud.ai/dashboard/agents/agent-8/chat?room=1",
        "https://cloud-staging.eliza.app/cloud/agents/agent-8?room=1",
      ],
      [
        "https://elizacloud.ai/dashboard/settings?tab=billing&payment=success",
        "https://cloud.eliza.app/cloud/billing?tab=billing&payment=success",
      ],
      [
        "https://api.elizacloud.ai/api/health?probe=1",
        "https://api.eliza.app/api/health?probe=1",
      ],
      [
        "https://staging.elizacloud.ai/dashboard",
        "https://cloud-staging.eliza.app/cloud",
      ],
      [
        "https://app-staging.elizacloud.ai/login",
        "https://cloud-staging.eliza.app/login",
      ],
      [
        "https://api-staging.elizacloud.ai/api/health",
        "https://api-staging.eliza.app/api/health",
      ],
      [
        "https://elizacloud.ai/api/v1/models?source=legacy",
        "https://api.eliza.app/api/v1/models?source=legacy",
      ],
      [
        "https://os.elizacloud.ai/downloads?platform=linux",
        "https://os.eliza.app/downloads?platform=linux",
      ],
      [
        "https://docs.elizacloud.ai/docs/api/agents?source=legacy",
        "https://eliza.app",
      ],
    ] as const;

    for (const [legacyUrl, canonicalUrl] of cases) {
      const response = redirectFrontendHost(new URL(legacyUrl), {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
      });
      expect(response?.status).toBe(308);
      expect(response?.headers.get("location")).toBe(canonicalUrl);
    }
  });

  test("does not redirect canonical marketing, app, or API hosts", () => {
    for (const canonicalUrl of [
      "https://eliza.app/login",
      "https://cloud.eliza.app/dashboard",
      "https://api.eliza.app/api/health",
      "https://staging.eliza.app/login",
      "https://cloud-staging.eliza.app/dashboard",
      "https://api-staging.eliza.app/api/health",
    ]) {
      expect(
        redirectFrontendHost(new URL(canonicalUrl), {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
        }),
      ).toBeNull();
    }
  });

  test("redirects legacy UUID agents and public service hosts", () => {
    const response = redirectFrontendHost(
      new URL(
        "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/chat?room=1",
      ),
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app" },
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get("location")).toBe(
      "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.cloud.eliza.app/chat?room=1",
    );
    const stagingResponse = redirectFrontendHost(
      new URL(
        "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.staging.elizacloud.ai/api/health?probe=1",
      ),
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud-staging.eliza.app" },
    );
    expect(stagingResponse?.status).toBe(308);
    expect(stagingResponse?.headers.get("location")).toBe(
      "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.cloud-staging.eliza.app/api/health?probe=1",
    );
    const serviceCases = [
      [
        "https://blob.elizacloud.ai/object.bin",
        "https://blob.eliza.app/object.bin",
      ],
      [
        "https://blob.elizacloud.ai/dashboard/image",
        "https://blob.eliza.app/dashboard/image",
      ],
      ["https://x402.elizacloud.ai/pay", "https://x402.eliza.app/pay"],
      [
        "https://relay.elizacloud.ai/v1/agent-tunnel",
        "https://relay.eliza.app/v1/agent-tunnel",
      ],
      [
        "https://relay-staging.elizacloud.ai/v1/agent-tunnel",
        "https://relay-staging.eliza.app/v1/agent-tunnel",
      ],
      [
        "https://session-7.tunnel.elizacloud.ai/ws?token=1",
        "https://session-7.tunnel.eliza.app/ws?token=1",
      ],
      [
        "https://plugins.elizacloud.ai/generated-registry.json",
        "https://plugins.eliza.app/generated-registry.json",
      ],
      [
        "https://site-7.sites.elizacloud.ai/?ref=legacy",
        "https://site-7.sites.eliza.app/?ref=legacy",
      ],
    ] as const;
    for (const [legacyUrl, canonicalUrl] of serviceCases) {
      const serviceResponse = redirectFrontendHost(new URL(legacyUrl), {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
      });
      expect(serviceResponse?.status).toBe(308);
      expect(serviceResponse?.headers.get("location")).toBe(canonicalUrl);
    }
  });

  test("identifies only unhandled legacy wildcard hosts", () => {
    expect(isUnsupportedLegacyWildcardHostname("unknown.elizacloud.ai")).toBe(
      true,
    );
    expect(isUnsupportedLegacyWildcardHostname("app-dev.elizacloud.ai")).toBe(
      true,
    );
    expect(
      isUnsupportedLegacyWildcardHostname("nested.unknown.elizacloud.ai"),
    ).toBe(true);
    expect(
      isUnsupportedLegacyWildcardHostname(
        "e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai",
      ),
    ).toBe(false);
    expect(isUnsupportedLegacyWildcardHostname("blob.elizacloud.ai")).toBe(
      false,
    );
    expect(isUnsupportedLegacyWildcardHostname("app.elizacloud.ai")).toBe(
      false,
    );
    expect(isUnsupportedLegacyWildcardHostname("unknown.example.com")).toBe(
      false,
    );
  });

  test("fails unknown legacy wildcard requests closed before API dispatch", async () => {
    for (const hostname of [
      "unknown.elizacloud.ai",
      "app-dev.elizacloud.ai",
      "nested.unknown.elizacloud.ai",
    ]) {
      const response = await cloudApiWorker.fetch(
        new Request(`https://${hostname}/api/health`),
        {} as never,
        {} as never,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
      expect(await response.text()).toBe('{"error":"not_found"}');
    }
  });

  test("extracts only canonical UUID hosts for the dedicated-agent proxy", () => {
    const env = { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app" };
    const agentId = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";

    expect(
      getGeneratedAgentId(
        new URL(`https://${agentId}.cloud.eliza.app/api/health`),
        env,
      ),
    ).toBe(agentId);
    expect(
      getGeneratedAgentId(
        new URL(`https://${agentId}.elizacloud.ai/api/health`),
        env,
      ),
    ).toBeNull();
    expect(
      getGeneratedAgentId(new URL("https://blob.elizacloud.ai/object"), env),
    ).toBeNull();
  });

  test("normalizes a 100k-dot configured hostname without pathological matching", () => {
    const agentId = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
    const env = {
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: `cloud.eliza.app${".".repeat(100_000)}`,
    };

    expect(
      getGeneratedAgentId(
        new URL(`https://${agentId}.cloud.eliza.app/api/health`),
        env,
      ),
    ).toBe(agentId);
  });

  test("proxies canonical staging marketing to the unified Pages develop branch", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://staging.eliza.app/dashboard?tab=agents"),
    );

    expect(target?.toString()).toBe(
      "https://develop.eliza-app.pages.dev/dashboard?tab=agents",
    );
  });

  test("proxies the canonical managed app to the unified Pages project", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://cloud.eliza.app/?runtime=first-run"),
    );

    expect(target?.toString()).toBe(
      "https://eliza-app.pages.dev/?runtime=first-run",
    );
  });

  test("proxies the canonical staging app to the Pages develop branch", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://cloud-staging.eliza.app/?runtime=first-run"),
    );

    expect(target?.toString()).toBe(
      "https://develop.eliza-app.pages.dev/?runtime=first-run",
    );
  });

  test("proxies staging API aliases to the staging API worker", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://staging.eliza.app/api/health"),
    );

    expect(target?.toString()).toBe("https://api-staging.eliza.app/api/health");
  });

  test("proxies staging managed-app API aliases to the staging API worker", () => {
    const target = getFrontendAliasProxyTarget(
      new URL("https://cloud-staging.eliza.app/api/health"),
    );

    expect(target?.toString()).toBe("https://api-staging.eliza.app/api/health");
  });

  test("exposes frontend alias API targets for in-process handling", () => {
    const target = getFrontendAliasApiProxyTarget(
      new URL("https://cloud-staging.eliza.app/api/status"),
    );

    expect(target?.toString()).toBe("https://api-staging.eliza.app/api/status");
  });

  test("handles staging managed-app API health in-process without external proxying", async () => {
    const originalFetch = globalThis.fetch;
    let didProxyExternally = false;

    globalThis.fetch = (() => {
      didProxyExternally = true;
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;

    try {
      const response = await cloudApiWorker.fetch(
        new Request("https://cloud-staging.eliza.app/api/health", {
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            "cf-ray": "test-ray",
            host: "cloud-staging.eliza.app",
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
      new Request("https://api-staging.eliza.app/api/health", {
        headers: {
          host: "api-staging.eliza.app",
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
      personalSharedTelegramEdge: { enabled: false },
      schemaCompatibility: { usageQuotasTombstone: true },
    });
  });

  test("reports only the served Personal Shared Telegram edge gate state", async () => {
    const response = await cloudApiWorker.fetch(
      new Request("https://api-staging.eliza.app/api/health", {
        headers: { host: "api-staging.eliza.app" },
      }),
      {
        ENVIRONMENT: "staging",
        PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED: "false",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED: "true",
        ELIZA_APP_TELEGRAM_BOT_TOKEN: "never-return-this-bot-token",
        ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: "never-return-this-webhook-secret",
      } as never,
      {} as never,
    );

    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      environment: "staging",
      personalSharedTelegramEdge: { enabled: true },
    });
    expect(text).not.toContain("never-return-this-bot-token");
    expect(text).not.toContain("never-return-this-webhook-secret");
  });

  test("reports only value-free staging session cutover readiness", async () => {
    const response = await cloudApiWorker.fetch(
      new Request("https://api-staging.eliza.app/api/health", {
        headers: { host: "api-staging.eliza.app" },
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
      new Request("https://api-staging.eliza.app/api/health", {
        headers: { host: "api-staging.eliza.app" },
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
      new Request("https://api-staging.eliza.app/api/health", {
        headers: { host: "api-staging.eliza.app" },
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

  test("leaves canonical frontend domains on Pages and routes only API and agent traffic to the staging Worker", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as {
      env?: {
        staging?: {
          routes?: Array<{ pattern?: string }>;
        };
        production?: {
          routes?: Array<{ pattern?: string }>;
        };
      };
    };

    const stagingRoutes =
      config.env?.staging?.routes?.map((route) => route.pattern) ?? [];

    expect(stagingRoutes).not.toContain("cloud-staging.eliza.app/*");
    expect(stagingRoutes).not.toContain("staging.eliza.app/*");
    expect(stagingRoutes).toContain("api-staging.eliza.app/*");
    expect(stagingRoutes).toContain("relay-staging.eliza.app/*");
    expect(stagingRoutes).toContain("*.cloud-staging.eliza.app/*");

    const productionRoutes =
      config.env?.production?.routes?.map((route) => route.pattern) ?? [];
    expect(productionRoutes).not.toContain("cloud.eliza.app/*");
    expect(productionRoutes).toContain("api.eliza.app/*");
    expect(productionRoutes).toContain("relay.eliza.app/*");
    expect(productionRoutes).toContain("*.cloud.eliza.app/*");
  });

  test("has no rollback flag to bypass the canonical Shared AgentRuntime", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as {
      vars?: { SHARED_ELIZA_AGENT_RUNTIME?: string };
      env?: {
        staging?: { vars?: { SHARED_ELIZA_AGENT_RUNTIME?: string } };
        production?: { vars?: { SHARED_ELIZA_AGENT_RUNTIME?: string } };
      };
    };

    expect(config.vars?.SHARED_ELIZA_AGENT_RUNTIME).toBeUndefined();
    expect(
      config.env?.staging?.vars?.SHARED_ELIZA_AGENT_RUNTIME,
    ).toBeUndefined();
    expect(
      config.env?.production?.vars?.SHARED_ELIZA_AGENT_RUNTIME,
    ).toBeUndefined();
  });

  test("keeps the legacy edge guard false and reserves the replacement names for the cutover secrets", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as {
      vars?: {
        PERSONAL_DELIVERY_PROJECTION_READ_ENABLED?: string;
        PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED?: string;
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED?: string;
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED?: string;
        ELIZA_INFERENCE_TIMING?: string;
      };
      env?: {
        staging?: {
          vars?: {
            PERSONAL_DELIVERY_PROJECTION_READ_ENABLED?: string;
            PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED?: string;
            PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED?: string;
            PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED?: string;
            ELIZA_INFERENCE_TIMING?: string;
          };
        };
        production?: {
          vars?: {
            PERSONAL_DELIVERY_PROJECTION_READ_ENABLED?: string;
            PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED?: string;
            PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED?: string;
            PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED?: string;
            ELIZA_INFERENCE_TIMING?: string;
          };
        };
      };
    };

    expect(config.vars?.PERSONAL_DELIVERY_PROJECTION_READ_ENABLED).toBe(
      "false",
    );
    expect(
      config.env?.staging?.vars?.PERSONAL_DELIVERY_PROJECTION_READ_ENABLED,
    ).toBe("false");
    expect(
      config.env?.production?.vars?.PERSONAL_DELIVERY_PROJECTION_READ_ENABLED,
    ).toBe("false");
    expect(config.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED).toBe("false");
    expect(
      config.env?.staging?.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.production?.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED,
    ).toBe("false");
    expect(
      config.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.staging?.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.production?.vars
        ?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED,
    ).toBeUndefined();
    expect(
      config.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.staging?.vars
        ?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED,
    ).toBeUndefined();
    expect(
      config.env?.production?.vars
        ?.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED,
    ).toBeUndefined();
    expect(config.vars?.ELIZA_INFERENCE_TIMING).toBeUndefined();
    expect(config.env?.staging?.vars?.ELIZA_INFERENCE_TIMING).toBe("info");
    expect(
      config.env?.production?.vars?.ELIZA_INFERENCE_TIMING,
    ).toBeUndefined();
  });

  test("binds the Personal Telegram delivery ledger in every Worker environment", async () => {
    type DurableBinding = { name?: string; class_name?: string };
    type DurableConfig = {
      bindings?: DurableBinding[];
    };
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as {
      durable_objects?: DurableConfig;
      env?: {
        staging?: { durable_objects?: DurableConfig };
        production?: { durable_objects?: DurableConfig };
      };
      exports?: Record<string, { type?: string; storage?: string }>;
    };

    for (const durableObjects of [
      config.durable_objects,
      config.env?.staging?.durable_objects,
      config.env?.production?.durable_objects,
    ]) {
      expect(durableObjects?.bindings).toContainEqual({
        name: "PERSONAL_TELEGRAM_DELIVERIES",
        class_name: "PersonalTelegramDelivery",
      });
    }
    expect(config.exports?.PersonalTelegramDelivery).toEqual({
      type: "durable-object",
      storage: "sqlite",
    });
  });

  test("binds Browser Run and the DoorDash checkout gate in every Worker environment", async () => {
    type DurableBinding = { name?: string; class_name?: string };
    type DurableConfig = { bindings?: DurableBinding[] };
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as {
      browser?: { binding?: string };
      durable_objects?: DurableConfig;
      env?: {
        staging?: {
          browser?: { binding?: string };
          durable_objects?: DurableConfig;
        };
        production?: {
          browser?: { binding?: string };
          durable_objects?: DurableConfig;
        };
      };
      migrations?: Array<{ tag?: string; new_sqlite_classes?: string[] }>;
    };

    expect(config.browser?.binding).toBe("BROWSER");
    expect(config.env?.staging?.browser?.binding).toBe("BROWSER");
    expect(config.env?.production?.browser?.binding).toBe("BROWSER");

    for (const durableObjects of [
      config.durable_objects,
      config.env?.staging?.durable_objects,
      config.env?.production?.durable_objects,
    ]) {
      expect(durableObjects?.bindings).toContainEqual({
        name: "DOORDASH_CHECKOUT_GATES",
        class_name: "DoorDashCheckoutGate",
      });
    }
    expect(config.migrations).toContainEqual({
      tag: "doordash-checkout-gates-v1",
      new_sqlite_classes: ["DoorDashCheckoutGate"],
    });
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
