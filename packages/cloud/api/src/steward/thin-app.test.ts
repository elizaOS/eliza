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
  isThinStewardPasskeyLoginOptionsPath,
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

function providersUpstreamResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({ ok: true, ...providersData(overrides) });
}

beforeEach(() => {
  resetProvidersResponseCacheForTests();
  globalThis.fetch = originalFetch;
});

async function expectInvalidProvidersResponse(
  upstreamResponse: Response,
): Promise<void> {
  stubFetch(async () => upstreamResponse);

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
}

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
  test("matches only the five email pre-auth legs", () => {
    expect(isThinStewardEmailAuthPath("/steward/auth/email/send")).toBe(true);
    expect(isThinStewardEmailAuthPath("/steward/auth/email/send/")).toBe(true);
    expect(isThinStewardEmailAuthPath("/steward/auth/email/code/verify")).toBe(
      true,
    );
    expect(isThinStewardEmailAuthPath("/steward/auth/email/status")).toBe(true);
    expect(isThinStewardEmailAuthPath("/steward/auth/email/otp/send")).toBe(
      true,
    );
    expect(isThinStewardEmailAuthPath("/steward/auth/email/otp/verify")).toBe(
      true,
    );
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

describe("isThinStewardPasskeyLoginOptionsPath", () => {
  test("matches only the pre-WebAuthn login-options request", () => {
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        "/steward/auth/passkey/login/options",
      ),
    ).toBe(true);
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        "/steward/auth/passkey/login/options/",
      ),
    ).toBe(true);
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        "/steward/auth/passkey/login/verify",
      ),
    ).toBe(false);
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        "/steward/auth/passkey/register/options",
      ),
    ).toBe(false);
    expect(
      isThinStewardPasskeyLoginOptionsPath(
        "/steward/auth/passkey/register/verify",
      ),
    ).toBe(false);
  });
});

describe("isThinStewardPath", () => {
  test("GET/HEAD only for public reads", () => {
    expect(isThinStewardPath("GET", "/steward/auth/providers")).toBe(true);
    expect(isThinStewardPath("HEAD", "/steward/tenants/config")).toBe(true);
    expect(isThinStewardPath("GET", "/steward/auth/email/send")).toBe(false);
  });

  test("POST only for the exact pre-auth email and passkey-bootstrap legs", () => {
    expect(isThinStewardPath("POST", "/steward/auth/email/send")).toBe(true);
    expect(isThinStewardPath("POST", "/steward/auth/email/code/verify")).toBe(
      true,
    );
    expect(isThinStewardPath("POST", "/steward/auth/email/status")).toBe(true);
    expect(isThinStewardPath("POST", "/steward/auth/email/otp/send")).toBe(
      true,
    );
    expect(isThinStewardPath("POST", "/steward/auth/email/otp/verify")).toBe(
      true,
    );
    expect(
      isThinStewardPath("POST", "/steward/auth/passkey/login/options"),
    ).toBe(true);
    expect(
      isThinStewardPath("POST", "/steward/auth/passkey/login/verify"),
    ).toBe(false);
    expect(
      isThinStewardPath("POST", "/steward/auth/passkey/register/options"),
    ).toBe(false);
    expect(
      isThinStewardPath("POST", "/steward/auth/passkey/register/verify"),
    ).toBe(false);
    expect(isThinStewardPath("POST", "/steward/auth/providers")).toBe(false);
    expect(isThinStewardPath("POST", "/steward/vault/keys")).toBe(false);
    expect(isThinStewardPath("PUT", "/steward/auth/email/send")).toBe(false);
    expect(isThinStewardPath("DELETE", "/steward/auth/email/send")).toBe(false);
  });

  test("OPTIONS eligible for both path families", () => {
    expect(isThinStewardPath("OPTIONS", "/steward/auth/providers")).toBe(true);
    expect(isThinStewardPath("OPTIONS", "/steward/auth/email/send")).toBe(true);
    expect(isThinStewardPath("OPTIONS", "/steward/auth/email/otp/send")).toBe(
      true,
    );
    expect(isThinStewardPath("OPTIONS", "/steward/auth/email/otp/verify")).toBe(
      true,
    );
    expect(
      isThinStewardPath("OPTIONS", "/steward/auth/passkey/login/options"),
    ).toBe(true);
    expect(
      isThinStewardPath("OPTIONS", "/steward/auth/passkey/register/options"),
    ).toBe(false);
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
        futureProvider: { state: "preview" },
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
      futureProvider?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.passkey).toBe(true);
    expect(body.google).toBe(true);
    expect(body.telegram).toBe(true);
    expect(body.oauth).toEqual(["apple", "google"]);
    expect(body.futureProvider).toEqual({ state: "preview" });
  });

  test("preserves the legacy nested shape and unknown envelope/provider fields", async () => {
    stubFetch(async () =>
      Response.json({
        ok: true,
        requestVersion: 7,
        data: providersData({
          oauth: ["apple"],
          sms: true,
          oidc: ["workforce"],
          disabled: ["line"],
          captcha: {
            enabled: true,
            provider: "turnstile",
            siteKey: "site-key",
            requiredFor: ["email_otp", "sms_otp"],
            futureCaptchaOption: "preserved",
          },
          futureProvider: { state: "preview" },
        }),
      }),
    );

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );
    const body = (await response.json()) as {
      ok?: boolean;
      requestVersion?: number;
      google?: boolean;
      data?: {
        google?: boolean;
        oauth?: string[];
        sms?: boolean;
        oidc?: string[];
        disabled?: string[];
        captcha?: Record<string, unknown>;
        futureProvider?: unknown;
      };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.requestVersion).toBe(7);
    expect(body.google).toBeUndefined();
    expect(body.data?.google).toBe(true);
    expect(body.data?.oauth).toEqual(["apple", "google"]);
    expect(body.data?.sms).toBe(true);
    expect(body.data?.oidc).toEqual(["workforce"]);
    expect(body.data?.disabled).toEqual(["line"]);
    expect(body.data?.captcha).toEqual({
      enabled: true,
      provider: "turnstile",
      siteKey: "site-key",
      requiredFor: ["email_otp", "sms_otp"],
      futureCaptchaOption: "preserved",
    });
    expect(body.data?.futureProvider).toEqual({ state: "preview" });
  });

  test.each([
    ["a wrong-typed boolean field", "passkey", "yes-actually-truthy"],
    ["a wrong-typed array field", "oauth", "google,apple"],
    ["a malformed captcha", "captcha", { enabled: "sure" }],
  ])(
    "drops %s smuggled beside a valid nested data object",
    async (_case, key, value) => {
      stubFetch(async () =>
        Response.json({
          ok: true,
          requestVersion: 7,
          [key]: value,
          data: providersData(),
        }),
      );

      const app = createStewardThinApp();
      const response = await app.request(
        "https://api.elizacloud.ai/steward/auth/providers",
        { method: "GET" },
        stewardEnv,
      );
      const body = (await response.json()) as Record<string, unknown> & {
        data?: Record<string, unknown>;
      };

      // The nested branch validates `data` alone, so an unvalidated
      // contract-named sibling must never be republished as healthy state.
      expect(response.status).toBe(200);
      expect(Object.hasOwn(body, key)).toBe(false);
      expect(body.ok).toBe(true);
      expect(body.requestVersion).toBe(7);
      expect(body.data?.passkey).toBe(true);
      expect(Array.isArray(body.data?.oauth)).toBe(true);
    },
  );

  test("keeps unknown envelope fields while dropping contract-named siblings", async () => {
    stubFetch(async () =>
      Response.json({
        ok: true,
        requestVersion: 7,
        futureEnvelopeField: { state: "preview" },
        passkey: "yes-actually-truthy",
        data: providersData({ sms: true }),
      }),
    );

    const app = createStewardThinApp();
    const response = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );
    const body = (await response.json()) as Record<string, unknown> & {
      data?: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.futureEnvelopeField).toEqual({ state: "preview" });
    expect(Object.hasOwn(body, "passkey")).toBe(false);
    expect(body.data?.sms).toBe(true);
  });

  test.each([
    ["object", { requestVersion: 7 }],
    ["null", null],
  ])(
    "preserves an unknown flat data field containing %s",
    async (_case, data) => {
      stubFetch(async () =>
        providersUpstreamResponse({
          data,
          futureProvider: { state: "preview" },
        }),
      );

      const app = createStewardThinApp();
      const response = await app.request(
        "https://api.elizacloud.ai/steward/auth/providers",
        { method: "GET" },
        stewardEnv,
      );
      const body = (await response.json()) as {
        data?: unknown;
        google?: boolean;
        futureProvider?: unknown;
      };

      expect(response.status).toBe(200);
      expect(body.data).toEqual(data);
      expect(body.google).toBe(true);
      expect(body.futureProvider).toEqual({ state: "preview" });
    },
  );

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
    "passkey",
    "email",
    "siwe",
    "siws",
    "google",
    "discord",
    "github",
    "twitter",
    "oauth",
  ])(
    "fails closed when required provider field %s is missing",
    async (field) => {
      const body: Record<string, unknown> = {
        ok: true,
        ...providersData(),
      };
      delete body[field];
      await expectInvalidProvidersResponse(Response.json(body));
    },
  );

  test.each([
    "passkey",
    "email",
    "siwe",
    "siws",
    "google",
    "discord",
    "github",
    "twitter",
  ])(
    "fails closed when required provider boolean %s is malformed",
    async (field) => {
      await expectInvalidProvidersResponse(
        providersUpstreamResponse({ [field]: "false" }),
      );
    },
  );

  test.each([
    "sms",
    "whatsapp",
    "totp",
    "telegram",
    "farcaster",
    "linkedin",
    "spotify",
    "twitch",
    "instagram",
    "line",
    "jwt",
  ])(
    "fails closed when optional provider boolean %s is malformed",
    async (field) => {
      await expectInvalidProvidersResponse(
        providersUpstreamResponse({ [field]: 1 }),
      );
    },
  );

  test.each([
    ["oauth is not an array", { oauth: { google: true } }],
    ["oauth contains a non-string", { oauth: ["google", 42] }],
    ["oidc is not an array", { oidc: "corp" }],
    ["oidc contains a non-string", { oidc: ["corp", false] }],
    ["disabled is not an array", { disabled: null }],
    ["disabled contains a non-string", { disabled: ["email", 7] }],
  ])("fails closed when %s", async (_case, overrides) => {
    await expectInvalidProvidersResponse(providersUpstreamResponse(overrides));
  });

  test.each([
    ["captcha is null", null],
    ["captcha is an array", []],
    ["captcha enabled is not boolean", { enabled: "true" }],
    ["captcha provider is not a string", { provider: 1 }],
    ["captcha provider is unsupported", { provider: "recaptcha" }],
    ["captcha siteKey is not a string", { siteKey: 123 }],
    ["captcha requiredFor is not an array", { requiredFor: "email_otp" }],
    [
      "captcha requiredFor contains a non-string",
      { requiredFor: ["email_otp", 1] },
    ],
    [
      "captcha requiredFor contains an unsupported purpose",
      { requiredFor: ["password"] },
    ],
  ])("fails closed when %s", async (_case, captcha) => {
    await expectInvalidProvidersResponse(
      providersUpstreamResponse({ captcha }),
    );
  });

  test.each([
    ["nested scalar provider data", "telegram"],
    ["nested array provider data", ["telegram"]],
    ["nested null provider data", null],
  ])("fails closed on %s", async (_case, data) => {
    await expectInvalidProvidersResponse(Response.json({ ok: true, data }));
  });

  test.each([
    ["non-JSON content type", new Response("not json", { status: 200 })],
    [
      "malformed JSON body",
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ],
  ])("fails closed on %s", async (_case, response) => {
    await expectInvalidProvidersResponse(response);
  });

  test.each([
    ["explicit unsuccessful flat envelope", { ok: false, ...providersData() }],
    [
      "conflicting success flag",
      { ok: true, success: false, ...providersData() },
    ],
    ["nested envelope without ok:true", { data: providersData() }],
    [
      "successful envelope carrying an error",
      { ok: true, error: "denied", ...providersData() },
    ],
  ])("fails closed on %s", async (_case, body) => {
    await expectInvalidProvidersResponse(Response.json(body));
  });

  test.each([
    [
      "duplicate keys",
      `{"ok":true,"passkey":true,"passkey":false,"email":true,"siwe":false,"siws":false,"google":false,"discord":false,"github":false,"twitter":false,"oauth":[]}`,
    ],
    [
      "prototype keys",
      `{"ok":true,"passkey":true,"email":true,"siwe":false,"siws":false,"google":false,"discord":false,"github":false,"twitter":false,"oauth":[],"__proto__":{}}`,
    ],
    [
      "excessive depth",
      JSON.stringify({
        ok: true,
        ...providersData(),
        future: Array.from({ length: 18 }).reduce((value) => [value], true),
      }),
    ],
    [
      "oversize body",
      JSON.stringify({
        ok: true,
        ...providersData(),
        future: "x".repeat(70_000),
      }),
    ],
  ])("rejects bounded JSON violation: %s", async (_case, body) => {
    await expectInvalidProvidersResponse(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
  });

  test("strips request credentials and upstream private headers before public caching", async () => {
    let sentHeaders: Headers | null = null;
    stubFetch(async (_input, init) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true, ...providersData() }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "session=secret",
          "www-authenticate": "Bearer secret",
          vary: "cookie, authorization",
          "x-private-token": "secret",
        },
      });
    });
    const response = await createStewardThinApp().request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {
        headers: {
          authorization: "Bearer browser-secret",
          cookie: "session=browser-secret",
          "x-api-key": "browser-key",
        },
      },
      stewardEnv,
    );

    expect(response.status).toBe(200);
    expect(sentHeaders).not.toBeNull();
    const capturedHeaders = sentHeaders as Headers | null;
    expect(capturedHeaders?.get("authorization")).toBeNull();
    expect(capturedHeaders?.get("cookie")).toBeNull();
    expect(capturedHeaders?.get("x-api-key")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    expect(response.headers.get("x-private-token")).toBeNull();
  });

  test("does not cache a malformed provider response", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return upstreamCalls === 1
        ? providersUpstreamResponse({ passkey: "true" })
        : providersUpstreamResponse();
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

    expect(first.status).toBe(502);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(upstreamCalls).toBe(2);
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

  test("isolates cache entries by tenant and OAuth representation inputs", async () => {
    let upstreamCalls = 0;
    stubFetch(async (_input, init) => {
      upstreamCalls += 1;
      const tenant = new Headers(init?.headers).get("x-steward-tenant");
      return providersUpstreamResponse({ futureTenant: tenant });
    });
    const app = createStewardThinApp();
    const envA = {
      ...stewardEnv,
      STEWARD_TENANT_ID: "tenant-a",
    } as unknown as AppEnv["Bindings"];
    const envB = {
      ...stewardEnv,
      STEWARD_TENANT_ID: "tenant-b",
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    } as unknown as AppEnv["Bindings"];
    const first = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {},
      envA,
    );
    const second = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {},
      envB,
    );

    expect(first.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(second.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(
      ((await first.json()) as { futureTenant?: unknown }).futureTenant,
    ).toBe("tenant-a");
    expect(
      ((await second.json()) as { futureTenant?: unknown }).futureTenant,
    ).toBe("tenant-b");
    expect(upstreamCalls).toBe(2);
  });

  test("a slow old cache generation cannot overwrite a faster new generation", async () => {
    let releaseOld!: () => void;
    const oldBarrier = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let upstreamCalls = 0;
    stubFetch(async (_input, init) => {
      upstreamCalls += 1;
      const tenant = new Headers(init?.headers).get("x-steward-tenant");
      if (tenant === "tenant-old") await oldBarrier;
      return providersUpstreamResponse({ futureTenant: tenant });
    });
    const app = createStewardThinApp();
    const oldEnv = {
      ...stewardEnv,
      STEWARD_TENANT_ID: "tenant-old",
    } as unknown as AppEnv["Bindings"];
    const newEnv = {
      ...stewardEnv,
      STEWARD_TENANT_ID: "tenant-new",
    } as unknown as AppEnv["Bindings"];
    const oldRequest = app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {},
      oldEnv,
    );
    const newResponse = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {},
      newEnv,
    );
    releaseOld();
    await oldRequest;
    const newHit = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {},
      newEnv,
    );

    expect(
      ((await newResponse.json()) as { futureTenant?: unknown }).futureTenant,
    ).toBe("tenant-new");
    expect(newHit.headers.get("x-eliza-providers-cache")).toBe("hit");
    expect(
      ((await newHit.json()) as { futureTenant?: unknown }).futureTenant,
    ).toBe("tenant-new");
    expect(upstreamCalls).toBe(2);
  });

  test("singleflights concurrent HEAD and GET onto one validated representation", async () => {
    let upstreamCalls = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubFetch(async () => {
      upstreamCalls += 1;
      await barrier;
      return providersUpstreamResponse({ futureGeneration: "same" });
    });
    const app = createStewardThinApp();
    const getPromise = app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      {},
      stewardEnv,
    );
    const headPromise = app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "HEAD" },
      stewardEnv,
    );
    await Promise.resolve();
    release();
    const [get, head] = await Promise.all([getPromise, headPromise]);

    expect(upstreamCalls).toBe(1);
    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(
      ((await get.json()) as { futureGeneration?: unknown }).futureGeneration,
    ).toBe("same");
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

  test("HEAD /steward/auth/providers validates GET upstream, strips the body, and primes the cache", async () => {
    let upstreamCalls = 0;
    stubFetch(async (_input, init) => {
      upstreamCalls += 1;
      expect(init?.method).toBe("GET");
      return providersUpstreamResponse();
    });

    const app = createStewardThinApp();
    const head = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "HEAD" },
      stewardEnv,
    );
    const get = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );

    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(get.status).toBe(200);
    expect(get.headers.get("x-eliza-providers-cache")).toBe("hit");
    expect(upstreamCalls).toBe(1);
  });

  test("HEAD /steward/auth/providers fails closed on malformed upstream and does not poison the cache", async () => {
    let upstreamCalls = 0;
    stubFetch(async () => {
      upstreamCalls += 1;
      return upstreamCalls === 1
        ? new Response("not json", { status: 200 })
        : providersUpstreamResponse();
    });

    const app = createStewardThinApp();
    const head = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "HEAD" },
      stewardEnv,
    );
    const get = await app.request(
      "https://api.elizacloud.ai/steward/auth/providers",
      { method: "GET" },
      stewardEnv,
    );

    expect(head.status).toBe(502);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(head.headers.get("x-eliza-providers-cache")).toBeNull();
    expect(get.status).toBe(200);
    expect(get.headers.get("x-eliza-providers-cache")).toBe("miss");
    expect(upstreamCalls).toBe(2);
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
