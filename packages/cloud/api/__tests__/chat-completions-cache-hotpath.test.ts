/**
 * Proves the Worker chat route reaches provider handoff using only cache
 * decisions. Required cold dependencies stay retryable, while optional
 * credential/catalog hydration never joins the provider request.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as authActual from "@/lib/auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as appsActual from "@/lib/services/apps";
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";
import * as modelCatalogActual from "@/lib/services/model-catalog";
import * as teamPoolActual from "@/lib/services/team-credential-pool";

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const APP_ID = "00000000-0000-4000-8000-0000000000dd";

let appCacheState: "ready" | "warming" = "ready";
let coldHydration: Promise<void> | null = null;
let poolCacheState: "ready" | "warming" = "ready";
let poolHydration: Promise<void> | null = null;
let catalogCacheState: "ready" | "warming" = "ready";
let catalogHydration: Promise<void> | null = null;
let platformCredentialConfigured = true;

const resolveInferenceAuthContext = mock(
  async (
    _request: Request,
    options: {
      cacheOnly?: boolean;
      executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    } = {},
  ) => {
    expect(options.cacheOnly).toBe(true);
    expect(options.executionCtx).toBeDefined();
    return {
      kind: "authorized" as const,
      source: "cache" as const,
      ctx: {
        v: 1 as const,
        cachedAt: Date.now(),
        userId: USER,
        orgId: ORG,
        apiKeyId: API_KEY_ID,
        keyHash: "a".repeat(64),
      },
    };
  },
);
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthActual,
  resolveInferenceAuthContext,
}));

const requireAuthOrApiKeyWithOrg = mock(async () => {
  throw new Error("authoritative auth must not run");
});
mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKeyWithOrg,
}));

const enforceOrgRateLimit = mock(
  async (
    organizationId: string,
    endpoint: string,
    options?: {
      cacheOnly?: boolean;
      executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    },
  ) => {
    expect(organizationId).toBe(ORG);
    expect(endpoint).toBe("completions");
    expect(options?.cacheOnly).toBe(true);
    expect(options?.executionCtx).toBeDefined();
    return null;
  },
);
mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit,
}));

const authoritativeAppLookup = mock(async () => {
  throw new Error("authoritative app lookup must not run");
});
const cacheOnlyAppLookup = mock(
  async (
    _appId: string,
    _user: { id: string; organization_id: string },
    options: { executionCtx?: { waitUntil(promise: Promise<unknown>): void } },
  ) => {
    if (appCacheState === "warming") {
      if (coldHydration && options.executionCtx) {
        options.executionCtx.waitUntil(coldHydration);
      }
      return { kind: "warming" as const, cacheRead: "miss" as const };
    }
    return {
      kind: "ready" as const,
      app: {
        id: APP_ID,
        organization_id: ORG,
        created_by_user_id: USER,
        monetization_enabled: true,
        platform_offset_amount: "0",
        purchase_share_percentage: "0",
        inference_markup_percentage: "10",
      },
    };
  },
);
mock.module("@/lib/services/apps", () => ({
  ...appsActual,
  appsService: {
    ...appsActual.appsService,
    getAuthorizedMonetizedAppForUser: authoritativeAppLookup,
    getAuthorizedMonetizedAppForUserCacheOnly: cacheOnlyAppLookup,
  },
}));

const shouldBlockUser = mock(async () => {
  throw new Error("authoritative moderation must not run");
});
mock.module("@/lib/services/content-moderation", () => ({
  ...contentModerationActual,
  contentModerationService: {
    ...contentModerationActual.contentModerationService,
    shouldBlockUser,
    moderateInBackground: async () => undefined,
  },
}));

const authoritativeCatalogLookup = mock(async () => {
  throw new Error("authoritative catalog lookup must not run");
});
const cacheOnlyCatalogLookup = mock(
  async (
    _model: string,
    options: {
      executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    } = {},
  ) => {
    if (catalogCacheState === "warming") {
      if (catalogHydration && options.executionCtx) {
        options.executionCtx.waitUntil(catalogHydration);
      }
      return {
        kind: "warming" as const,
        cacheRead: "miss" as const,
      };
    }
    return {
      kind: "ready" as const,
      model: null,
      stale: false,
    };
  },
);
mock.module("@/lib/services/model-catalog", () => ({
  ...modelCatalogActual,
  getCachedGatewayModelById: authoritativeCatalogLookup,
  getGatewayModelByIdCacheOnly: cacheOnlyCatalogLookup,
}));

const authoritativePoolSelection = mock(async () => {
  throw new Error("authoritative credential selection must not run");
});
const cacheOnlyPoolSelection = mock(
  async (
    _params: unknown,
    options: {
      executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    } = {},
  ) => {
    if (poolCacheState === "warming") {
      if (poolHydration && options.executionCtx) {
        options.executionCtx.waitUntil(poolHydration);
      }
      return { kind: "warming" as const };
    }
    return {
      kind: "ready" as const,
      credential: null,
    };
  },
);
mock.module("@/lib/services/team-credential-pool", () => ({
  ...teamPoolActual,
  getTeamPoolRegistry: () => ({
    selectCredential: authoritativePoolSelection,
    selectCredentialCacheOnly: cacheOnlyPoolSelection,
    recordUse: async () => undefined,
    recordUseOffPath: () => undefined,
    recordProviderFailure: async () => undefined,
    recordProviderFailureOffPath: () => undefined,
  }),
}));

const calculateCost = mock(
  async (
    _model: string,
    _provider: string,
    _inputTokens: number,
    _outputTokens: number,
    _billingSource: string,
    options?: {
      cacheOnly?: boolean;
      executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    },
  ) => {
    expect(options?.cacheOnly).toBe(true);
    expect(options?.executionCtx).toBeDefined();
    return { inputCost: 0.001, outputCost: 0.001, totalCost: 0.002 };
  },
);
mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasLanguageModelProviderConfigured: () => platformCredentialConfigured,
  getLanguageModel: () => ({}) as never,
}));

const settle = mock(async () => null);
const settleUnknown = mock(async () => null);
const admitAppInferenceCacheOnly = mock(async () => ({
  mode: "deferred_app_reservation" as const,
  estimatedTotalCostUsd: 0.002,
  settle,
  settleUnknown,
}));
class TestInferenceAppAffiliateUnsupportedError extends Error {}
const assertInferenceAppAffiliateSupported = mock(
  (_appId: string, affiliateCode: string | null | undefined) => {
    if (affiliateCode?.trim()) {
      throw new TestInferenceAppAffiliateUnsupportedError();
    }
  },
);
mock.module("@/lib/services/app-inference-admission", () => ({
  admitAppInferenceCacheOnly,
  assertInferenceAppAffiliateSupported,
  InferenceAppAffiliateUnsupportedError:
    TestInferenceAppAffiliateUnsupportedError,
}));

const generateText = mock(() => {
  throw new Error("provider-handoff");
});
mock.module("ai", () => ({
  ...aiActual,
  generateText,
  streamText: () => {
    throw new Error("provider-handoff");
  },
}));

const { handleChatCompletionsPOST } = await import(
  "../v1/chat/completions/route"
);

afterAll(() => {
  mock.restore();
});

function request(extraHeaders: Record<string, string> = {}): Request {
  return new Request("https://api.example/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "eliza_test",
      "x-app-id": APP_ID,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });
}

function executionCtx(background: Promise<unknown>[]) {
  return {
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  };
}

beforeEach(() => {
  appCacheState = "ready";
  coldHydration = null;
  poolCacheState = "ready";
  poolHydration = null;
  catalogCacheState = "ready";
  catalogHydration = null;
  platformCredentialConfigured = true;
  resolveInferenceAuthContext.mockClear();
  requireAuthOrApiKeyWithOrg.mockClear();
  enforceOrgRateLimit.mockClear();
  authoritativeAppLookup.mockClear();
  cacheOnlyAppLookup.mockClear();
  shouldBlockUser.mockClear();
  authoritativeCatalogLookup.mockClear();
  cacheOnlyCatalogLookup.mockClear();
  authoritativePoolSelection.mockClear();
  cacheOnlyPoolSelection.mockClear();
  calculateCost.mockClear();
  admitAppInferenceCacheOnly.mockClear();
  assertInferenceAppAffiliateSupported.mockClear();
  settle.mockClear();
  settleUnknown.mockClear();
  generateText.mockClear();
});

test("warm Worker request reaches provider with authoritative stores tripwired", async () => {
  const background: Promise<unknown>[] = [];

  const response = await handleChatCompletionsPOST(request(), {
    executionCtx: executionCtx(background),
  });

  expect(response.status).toBe(500);
  expect(generateText).toHaveBeenCalledTimes(1);
  expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
  expect(enforceOrgRateLimit).toHaveBeenCalledTimes(1);
  expect(cacheOnlyAppLookup).toHaveBeenCalledTimes(1);
  expect(cacheOnlyCatalogLookup).toHaveBeenCalledTimes(1);
  expect(cacheOnlyPoolSelection).toHaveBeenCalledTimes(1);
  expect(admitAppInferenceCacheOnly).toHaveBeenCalledTimes(1);
  expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
  expect(authoritativeAppLookup).not.toHaveBeenCalled();
  expect(authoritativeCatalogLookup).not.toHaveBeenCalled();
  expect(authoritativePoolSelection).not.toHaveBeenCalled();
  expect(shouldBlockUser).not.toHaveBeenCalled();
});

test("preserves a cached standing 503 before provider dispatch", async () => {
  resolveInferenceAuthContext.mockResolvedValueOnce({
    kind: "rejected",
    status: 503,
  } as never);
  const background: Promise<unknown>[] = [];

  const response = await handleChatCompletionsPOST(request(), {
    executionCtx: executionCtx(background),
  });

  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toMatchObject({
    error: {
      type: "service_unavailable",
      code: "service_unavailable",
      details: { reason: "authorization_unavailable" },
    },
  });
  expect(enforceOrgRateLimit).not.toHaveBeenCalled();
  expect(admitAppInferenceCacheOnly).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
});

test("returns a typed cached standing reason before provider dispatch", async () => {
  resolveInferenceAuthContext.mockResolvedValueOnce({
    kind: "rejected",
    status: 403,
    reason: "organization_inactive",
  } as never);
  const background: Promise<unknown>[] = [];

  const response = await handleChatCompletionsPOST(request(), {
    executionCtx: executionCtx(background),
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: {
      message: "Organization is inactive",
      code: "access_denied",
      details: { reason: "organization_inactive" },
    },
  });
  expect(admitAppInferenceCacheOnly).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
});

test("cold dependency returns 503 before held hydration completes", async () => {
  appCacheState = "warming";
  const hydration = Promise.withResolvers<void>();
  coldHydration = hydration.promise;
  const background: Promise<unknown>[] = [];

  const outcome = await Promise.race([
    handleChatCompletionsPOST(request(), {
      executionCtx: executionCtx(background),
    }).then((response) => ({ kind: "response" as const, response })),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 100),
    ),
  ]);

  expect(outcome.kind).toBe("response");
  if (outcome.kind !== "response") {
    throw new Error("chat route joined authoritative cache hydration");
  }
  expect(outcome.response.status).toBe(503);
  expect(outcome.response.headers.get("Retry-After")).toBe("1");
  expect(background).toContain(hydration.promise);
  expect(generateText).not.toHaveBeenCalled();
  expect(admitAppInferenceCacheOnly).not.toHaveBeenCalled();
  expect(authoritativeAppLookup).not.toHaveBeenCalled();
  hydration.resolve();
  await Promise.all(background);
});

test("cold rate-limit policy returns a bounded retry contract", async () => {
  enforceOrgRateLimit.mockRejectedValueOnce(
    new rateLimitActual.OrgRateLimitCacheNotReadyError("warming", "miss"),
  );
  const background: Promise<unknown>[] = [];

  const response = await handleChatCompletionsPOST(request(), {
    executionCtx: executionCtx(background),
  });

  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toMatchObject({
    error: { code: "rate_limit_cache_warming" },
  });
  expect(cacheOnlyAppLookup).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
});

test("cold optional pool and model catalog hydrate off-path while platform inference dispatches", async () => {
  poolCacheState = "warming";
  catalogCacheState = "warming";
  const pool = Promise.withResolvers<void>();
  const catalog = Promise.withResolvers<void>();
  poolHydration = pool.promise;
  catalogHydration = catalog.promise;
  const background: Promise<unknown>[] = [];

  const outcome = await Promise.race([
    handleChatCompletionsPOST(request(), {
      executionCtx: executionCtx(background),
    }).then((response) => ({ kind: "response" as const, response })),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 100),
    ),
  ]);

  expect(outcome.kind).toBe("response");
  if (outcome.kind !== "response") {
    throw new Error("chat route joined optional dependency hydration");
  }
  expect(outcome.response.status).toBe(500);
  expect(generateText).toHaveBeenCalledTimes(1);
  expect(background).toContain(pool.promise);
  expect(background).toContain(catalog.promise);
  expect(authoritativePoolSelection).not.toHaveBeenCalled();
  expect(authoritativeCatalogLookup).not.toHaveBeenCalled();

  pool.resolve();
  catalog.resolve();
  await Promise.all(background);
});

test("cold pool remains retryable when no platform credential can dispatch", async () => {
  platformCredentialConfigured = false;
  poolCacheState = "warming";
  const pool = Promise.withResolvers<void>();
  poolHydration = pool.promise;
  const background: Promise<unknown>[] = [];

  const response = await handleChatCompletionsPOST(request(), {
    executionCtx: executionCtx(background),
  });

  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toMatchObject({
    error: { code: "inference_dependency_cache_warming" },
  });
  expect(generateText).not.toHaveBeenCalled();
  pool.resolve();
  await Promise.all(background);
});

test("app monetization plus affiliate attribution fails closed before provider dispatch", async () => {
  const background: Promise<unknown>[] = [];

  const response = await handleChatCompletionsPOST(
    request({ "x-affiliate-code": "partner" }),
    { executionCtx: executionCtx(background) },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "unsupported_billing_combination" },
  });
  expect(assertInferenceAppAffiliateSupported).toHaveBeenCalledWith(
    APP_ID,
    "partner",
  );
  expect(admitAppInferenceCacheOnly).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
  await Promise.all(background);
});
