/**
 * Deterministic unit coverage for generative-route-auth. The module under
 * test is imported for real; collaborator services are stubbed so execution
 * context detection, cache-error mapping, flat admission, and caller
 * resolution can run without Worker KV or database.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class AiPricingCacheWarmingError extends Error {
  constructor() {
    super("AI pricing cache is warming; retry the request");
    this.name = "AiPricingCacheWarmingError";
  }
}

class AiPricingCacheUnavailableError extends Error {
  constructor() {
    super("AI pricing cache is unavailable; retry the request");
    this.name = "AiPricingCacheUnavailableError";
  }
}

const resolveInferenceAuthContext = vi.fn();
const requireAuthOrApiKeyWithOrg = vi.fn();
const requireUserOrApiKeyWithOrg = vi.fn();
const reserveFlatUsageCredits = vi.fn();
const admitOrganizationInference = vi.fn();
const enforceOrgRateLimit = vi.fn();
const inferenceRateLimitConfig = vi.fn();
const loggerWarn = vi.fn();

vi.mock("@/lib/api/cloud-worker-errors", () => ({ ApiError }));
vi.mock("@/lib/services/ai-pricing/cache", () => ({
  AiPricingCacheWarmingError,
  AiPricingCacheUnavailableError,
}));
vi.mock("@/lib/services/inference-auth-context", () => ({
  resolveInferenceAuthContext,
}));
vi.mock("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
vi.mock("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
vi.mock("@/lib/services/ai-billing", () => ({ reserveFlatUsageCredits }));
vi.mock("@/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference,
}));
vi.mock("@/lib/middleware/rate-limit", () => ({ enforceOrgRateLimit }));
vi.mock("@/lib/services/inference-admission-snapshot", () => ({
  inferenceRateLimitConfig,
}));
vi.mock("@/lib/utils/logger", () => ({
  logger: { warn: loggerWarn },
}));

if (typeof Bun !== "undefined") {
  const bunTest = await import("bun:test");
  bunTest.mock.module("@/lib/api/cloud-worker-errors", () => ({ ApiError }));
  bunTest.mock.module("@/lib/services/ai-pricing/cache", () => ({
    AiPricingCacheWarmingError,
    AiPricingCacheUnavailableError,
  }));
  bunTest.mock.module("@/lib/services/inference-auth-context", () => ({
    resolveInferenceAuthContext,
  }));
  bunTest.mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
  bunTest.mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg,
  }));
  bunTest.mock.module("@/lib/services/ai-billing", () => ({
    reserveFlatUsageCredits,
  }));
  bunTest.mock.module(
    "@/lib/services/organization-inference-admission",
    () => ({
      admitOrganizationInference,
    }),
  );
  bunTest.mock.module("@/lib/middleware/rate-limit", () => ({
    enforceOrgRateLimit,
  }));
  bunTest.mock.module("@/lib/services/inference-admission-snapshot", () => ({
    inferenceRateLimitConfig,
  }));
  bunTest.mock.module("@/lib/utils/logger", () => ({
    logger: { warn: loggerWarn },
  }));
}

const {
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  getGenerativePricingCacheOptions,
  requireGenerativeRouteCaller,
  resolveInferenceAuthStandingDenial,
} = await import("./generative-route-auth");

const FLAT_COST = {
  totalCost: 1.25,
  baseTotalCost: 1,
  platformMarkup: 0.25,
};

function workerContext(storeSeed?: Record<string, unknown>) {
  const waited: Promise<unknown>[] = [];
  const store = new Map<string, unknown>(Object.entries(storeSeed ?? {}));
  const executionCtx = {
    waitUntil(promise: Promise<unknown>) {
      waited.push(promise);
    },
  };
  return {
    waited,
    store,
    executionCtx,
    c: {
      executionCtx,
      req: { raw: new Request("https://api.eliza.app/api/v1/generate-image") },
      get(key: string) {
        return store.get(key);
      },
      set(key: string, value: unknown) {
        store.set(key, value);
      },
    },
  };
}

function localContext(storeSeed?: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(storeSeed ?? {}));
  return {
    store,
    c: {
      req: { raw: new Request("https://api.eliza.app/api/v1/generate-image") },
      get(key: string) {
        return store.get(key);
      },
      set(key: string, value: unknown) {
        store.set(key, value);
      },
    },
  };
}

function billingContext() {
  return {
    organizationId: "org-1",
    userId: "user-1",
    model: "gpt-4o",
    provider: "openai",
    billingSource: "openai" as const,
    requestId: "req-1",
  };
}

function namedError(name: string, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function admissionSnapshot() {
  return {
    balance: {
      balanceUsd: 12,
      balanceAt: 1,
      balanceRevision: "1",
    },
    rateLimits: {
      completionsRpm: 10,
      embeddingsRpm: 10,
      standardRpm: 10,
      strictRpm: 10,
    },
  };
}

const sessionAuthorized = {
  kind: "authorized" as const,
  source: "cache" as const,
  ctx: {
    userId: "user-1",
    orgId: "org-1",
    apiKeyId: null,
    admission: admissionSnapshot(),
  },
};

const apiKeyAuthorized = {
  kind: "authorized" as const,
  source: "cache" as const,
  ctx: {
    userId: "user-1",
    orgId: "org-1",
    apiKeyId: "key-1",
    appScopeId: "app-1",
    admission: admissionSnapshot(),
  },
};

describe("getGenerativeExecutionContext", () => {
  test("returns the Worker context when waitUntil is a function", () => {
    const { c, executionCtx } = workerContext();
    expect(getGenerativeExecutionContext(c as never)).toBe(executionCtx);
  });

  test("returns undefined when executionCtx is missing", () => {
    expect(getGenerativeExecutionContext(localContext().c as never)).toBe(
      undefined,
    );
  });

  test("returns undefined when waitUntil is not a function", () => {
    expect(
      getGenerativeExecutionContext({
        executionCtx: { waitUntil: "later" },
      } as never),
    ).toBe(undefined);
  });

  test("returns undefined when executionCtx is null", () => {
    expect(getGenerativeExecutionContext({ executionCtx: null } as never)).toBe(
      undefined,
    );
  });

  test("returns undefined when reading executionCtx throws", () => {
    const c = {
      get executionCtx(): never {
        throw new Error("ExecutionContext is not available");
      },
    };
    expect(getGenerativeExecutionContext(c as never)).toBe(undefined);
  });
});

describe("getGenerativePricingCacheOptions", () => {
  test("sets cacheOnly when a Worker waitUntil context is present", () => {
    const { c, executionCtx } = workerContext();
    expect(getGenerativePricingCacheOptions(c as never)).toEqual({
      cacheOnly: true,
      executionCtx,
    });
  });

  test("sets cacheOnly false and omits executionCtx on the local path", () => {
    expect(getGenerativePricingCacheOptions(localContext().c as never)).toEqual(
      {
        cacheOnly: false,
        executionCtx: undefined,
      },
    );
  });

  test("does not treat a waitUntil-less object as cache-only", () => {
    expect(
      getGenerativePricingCacheOptions({
        executionCtx: { waitUntil: undefined },
      } as never),
    ).toEqual({
      cacheOnly: false,
      executionCtx: undefined,
    });
  });
});

describe("asGenerativeCacheApiError", () => {
  test("maps AiPricingCacheWarmingError to a retryable 503", () => {
    const mapped = asGenerativeCacheApiError(new AiPricingCacheWarmingError());
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped?.status).toBe(503);
    expect(mapped?.code).toBe("service_unavailable");
    expect(mapped?.message).toBe(
      "Generative admission cache is warming; retry shortly",
    );
    expect(mapped?.details).toEqual({
      retryable: true,
      retryAfterSeconds: 1,
    });
  });

  test("maps AiPricingCacheUnavailableError to the same retryable 503", () => {
    const mapped = asGenerativeCacheApiError(
      new AiPricingCacheUnavailableError(),
    );
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped?.status).toBe(503);
    expect(mapped?.code).toBe("service_unavailable");
  });

  test("maps Inference* Warming errors by name", () => {
    const mapped = asGenerativeCacheApiError(
      namedError("InferenceAuthCacheWarmingError"),
    );
    expect(mapped?.status).toBe(503);
    expect(mapped?.code).toBe("service_unavailable");
  });

  test("maps Inference* Unavailable errors by name", () => {
    const mapped = asGenerativeCacheApiError(
      namedError("InferenceBalanceCacheUnavailableError"),
    );
    expect(mapped?.status).toBe(503);
  });

  test("returns null for Inference errors without Warming or Unavailable", () => {
    expect(
      asGenerativeCacheApiError(namedError("InferenceAuthCacheHitError")),
    ).toBe(null);
  });

  test("returns null when Warming is in the name but Inference is not the prefix", () => {
    expect(
      asGenerativeCacheApiError(namedError("AiPricingCacheWarmingErrorX")),
    ).toBe(null);
  });

  test("returns null for generic errors, strings, and non-errors", () => {
    expect(asGenerativeCacheApiError(new Error("nope"))).toBe(null);
    expect(asGenerativeCacheApiError("warming")).toBe(null);
    expect(asGenerativeCacheApiError(null)).toBe(null);
    expect(asGenerativeCacheApiError({ name: "InferenceWarmingError" })).toBe(
      null,
    );
  });
});

describe("admitFlatGenerativeOperation", () => {
  let reconcile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reconcile = vi.fn(async (actualCostUsd: number) => ({ actualCostUsd }));
    reserveFlatUsageCredits.mockReset();
    admitOrganizationInference.mockReset();
    reserveFlatUsageCredits.mockImplementation(async () => ({
      affiliateAttribution: { code: "aff-1" },
      reconcile,
    }));
  });

  afterEach(() => {
    reserveFlatUsageCredits.mockReset();
    admitOrganizationInference.mockReset();
  });

  test("rejects when provider is missing", async () => {
    await expect(
      admitFlatGenerativeOperation({
        c: localContext().c as never,
        context: {
          organizationId: "org-1",
          userId: "user-1",
          model: "gpt-4o",
          billingSource: "openai",
          requestId: "req-1",
        },
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toThrow(
      "Flat generative admission requires provider, billingSource, and requestId",
    );
    expect(reserveFlatUsageCredits).not.toHaveBeenCalled();
  });

  test("rejects when billingSource is an empty string", async () => {
    await expect(
      admitFlatGenerativeOperation({
        c: localContext().c as never,
        context: { ...billingContext(), billingSource: "" as never },
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toThrow(
      "Flat generative admission requires provider, billingSource, and requestId",
    );
  });

  test("rejects when requestId is missing", async () => {
    await expect(
      admitFlatGenerativeOperation({
        c: localContext().c as never,
        context: {
          organizationId: "org-1",
          userId: "user-1",
          model: "gpt-4o",
          provider: "openai",
          billingSource: "openai",
        },
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toThrow(
      "Flat generative admission requires provider, billingSource, and requestId",
    );
  });

  test("reserves synchronously when no Worker execution context is present", async () => {
    const context = billingContext();
    const admission = await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context,
      apiKeyId: "key-1",
      cost: FLAT_COST,
      idempotencyKey: "idem-1",
    });

    expect(reserveFlatUsageCredits).toHaveBeenCalledTimes(1);
    expect(reserveFlatUsageCredits).toHaveBeenCalledWith(context, FLAT_COST, {
      idempotencyKey: "idem-1",
    });
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(admission.mode).toBe("synchronous_reservation");
    expect(admission.affiliateAttribution).toEqual({ code: "aff-1" });

    await expect(admission.settle(0.8)).resolves.toEqual({
      actualCostUsd: 0.8,
    });
    await expect(admission.settle(0.9)).resolves.toBe(null);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test("passes undefined options when idempotencyKey is absent", async () => {
    await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
    });
    expect(reserveFlatUsageCredits.mock.calls[0]?.[2]).toBe(undefined);
  });

  test("treats an empty idempotencyKey as absent", async () => {
    await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
      idempotencyKey: "",
    });
    expect(reserveFlatUsageCredits.mock.calls[0]?.[2]).toBe(undefined);
  });

  test("settleUnknown conservatively uses the estimated totalCost", async () => {
    const admission = await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
    });
    await expect(admission.settleUnknown()).resolves.toEqual({
      actualCostUsd: FLAT_COST.totalCost,
    });
    expect(reconcile).toHaveBeenCalledWith(FLAT_COST.totalCost);
  });

  test("maps missing reservation affiliateAttribution to null", async () => {
    reserveFlatUsageCredits.mockImplementation(async () => ({
      reconcile,
    }));
    const admission = await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
    });
    expect(admission.affiliateAttribution).toBe(null);
  });

  test("maps an undefined reconcile result to null", async () => {
    reconcile.mockResolvedValueOnce(undefined);
    const admission = await admitFlatGenerativeOperation({
      c: localContext().c as never,
      context: billingContext(),
      apiKeyId: null,
      cost: FLAT_COST,
    });
    await expect(admission.settle(1)).resolves.toBe(null);
  });

  test("admits through the Worker path when waitUntil is present", async () => {
    const { c, executionCtx } = workerContext();
    const snapshot = admissionSnapshot();
    const workerAdmission = {
      mode: "durable_object_debit" as const,
      settle: async () => null,
      settleUnknown: async () => null,
    };
    admitOrganizationInference.mockResolvedValueOnce(workerAdmission);

    const context = { ...billingContext(), affiliateCode: "ref-9" };
    const result = await admitFlatGenerativeOperation({
      c: c as never,
      context,
      apiKeyId: "key-1",
      cost: FLAT_COST,
      admissionSnapshot: snapshot,
    });

    expect(result).toBe(workerAdmission);
    expect(reserveFlatUsageCredits).not.toHaveBeenCalled();
    expect(admitOrganizationInference).toHaveBeenCalledWith({
      context,
      apiKeyId: "key-1",
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      affiliateCode: "ref-9",
      executionCtx,
      flatCost: FLAT_COST,
      admissionSnapshot: snapshot,
    });
  });

  test("wraps Inference Warming failures from Worker admission as 503", async () => {
    const { c } = workerContext();
    admitOrganizationInference.mockRejectedValueOnce(
      namedError("InferenceAffiliateCacheWarmingError"),
    );
    await expect(
      admitFlatGenerativeOperation({
        c: c as never,
        context: billingContext(),
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "Billing cache is warming; retry shortly",
    });
  });

  test("wraps Inference Unavailable failures from Worker admission as 503", async () => {
    const { c } = workerContext();
    admitOrganizationInference.mockRejectedValueOnce(
      namedError("InferenceBalanceCacheUnavailableError"),
    );
    await expect(
      admitFlatGenerativeOperation({
        c: c as never,
        context: billingContext(),
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
  });

  test("rethrows AiPricingCacheWarmingError from Worker admission unchanged", async () => {
    const { c } = workerContext();
    const original = new AiPricingCacheWarmingError();
    admitOrganizationInference.mockRejectedValueOnce(original);
    await expect(
      admitFlatGenerativeOperation({
        c: c as never,
        context: billingContext(),
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toBe(original);
  });

  test("rethrows non-Error Worker admission failures unchanged", async () => {
    const { c } = workerContext();
    admitOrganizationInference.mockRejectedValueOnce("boom");
    await expect(
      admitFlatGenerativeOperation({
        c: c as never,
        context: billingContext(),
        apiKeyId: null,
        cost: FLAT_COST,
      }),
    ).rejects.toBe("boom");
  });
});

describe("resolveInferenceAuthStandingDenial", () => {
  beforeEach(() => {
    loggerWarn.mockReset();
  });

  test("preserves a retryable resolver 503 and logs only bounded fields", () => {
    const denial = resolveInferenceAuthStandingDenial(
      { kind: "rejected", status: 503 },
      { route: "embeddings", traceId: "trace-1" },
    );

    expect(denial).toEqual({
      status: 503,
      type: "service_unavailable",
      code: "service_unavailable",
      message: "Authorization service is unavailable. Retry shortly.",
      reason: "authorization_unavailable",
      retryAfterSeconds: 1,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      "[InferenceAuth] blocked provider dispatch at route boundary",
      {
        route: "embeddings",
        traceId: "trace-1",
        decision: "rejected",
        status: 503,
        reason: "authorization_unavailable",
        retryable: true,
      },
    );
  });

  test("maps every typed standing reason without replacing resolver status", () => {
    expect(
      resolveInferenceAuthStandingDenial({
        kind: "rejected",
        status: 403,
        reason: "organization_inactive",
      }),
    ).toMatchObject({
      status: 403,
      message: "Organization is inactive",
      reason: "organization_inactive",
    });
    expect(
      resolveInferenceAuthStandingDenial({
        kind: "rejected",
        status: 401,
        reason: "credential_invalid",
      }),
    ).toMatchObject({
      status: 401,
      message: "Authentication required",
      reason: "credential_invalid",
    });
    expect(
      resolveInferenceAuthStandingDenial({
        kind: "suspended",
        reason: "moderation_blocked",
      }),
    ).toMatchObject({
      status: 403,
      message: "Account access is blocked by policy moderation",
      reason: "moderation_blocked",
    });
  });
});

describe("requireGenerativeRouteCaller", () => {
  beforeEach(() => {
    resolveInferenceAuthContext.mockReset();
    requireAuthOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockReset();
    enforceOrgRateLimit.mockReset();
    inferenceRateLimitConfig.mockReset();
    requireAuthOrApiKeyWithOrg.mockResolvedValue({
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-raw" },
    });
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    enforceOrgRateLimit.mockResolvedValue(null);
    inferenceRateLimitConfig.mockReturnValue({
      windowMs: 1000,
      maxRequests: 10,
    });
  });

  afterEach(() => {
    resolveInferenceAuthContext.mockReset();
    requireAuthOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockReset();
    enforceOrgRateLimit.mockReset();
    inferenceRateLimitConfig.mockReset();
  });

  test("uses raw compatibility auth when no Worker context is present", async () => {
    const { c } = localContext();
    const caller = await requireGenerativeRouteCaller(c as never, {
      compatibility: "raw",
    });
    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(resolveInferenceAuthContext).not.toHaveBeenCalled();
    expect(caller).toEqual({
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: "key-raw",
      authSource: "compatibility",
      appScopeId: null,
    });
  });

  test("maps a missing raw api key to a null apiKeyId", async () => {
    requireAuthOrApiKeyWithOrg.mockResolvedValueOnce({
      user: { id: "user-1", organization_id: "org-1" },
    });
    const caller = await requireGenerativeRouteCaller(
      localContext().c as never,
      { compatibility: "raw" },
    );
    expect(caller.apiKeyId).toBe(null);
  });

  test("uses Hono compatibility auth by default without a Worker context", async () => {
    const { c } = localContext({ apiKeyId: "from-store" });
    const caller = await requireGenerativeRouteCaller(c as never);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(caller.authSource).toBe("compatibility");
    expect(caller.apiKeyId).toBe("from-store");
    expect(caller.appScopeId).toBe(null);
  });

  test("maps a missing Hono apiKeyId store value to null", async () => {
    const caller = await requireGenerativeRouteCaller(
      localContext().c as never,
      { compatibility: "hono" },
    );
    expect(caller.apiKeyId).toBe(null);
  });

  test("returns combined_cache for an authorized session snapshot", async () => {
    const { c, store } = workerContext({
      traceId: "trace-1",
      requestId: "req-fallback",
    });
    resolveInferenceAuthContext.mockResolvedValueOnce(sessionAuthorized);

    const caller = await requireGenerativeRouteCaller(c as never);

    expect(resolveInferenceAuthContext).toHaveBeenCalledWith(c.req.raw, {
      traceId: "trace-1",
      cacheOnly: true,
      executionCtx: c.executionCtx,
    });
    expect(caller).toMatchObject({
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: null,
      authSource: "combined_cache",
      appScopeId: null,
    });
    expect(caller.admissionSnapshot).toEqual(sessionAuthorized.ctx.admission);
    expect(store.get("user")).toEqual({
      id: "user-1",
      organization_id: "org-1",
    });
    expect(store.get("authMethod")).toBe("session");
    expect(store.has("apiKeyId")).toBe(false);
  });

  test("falls back to requestId when traceId is unset", async () => {
    const { c } = workerContext({ requestId: "req-only" });
    resolveInferenceAuthContext.mockResolvedValueOnce(sessionAuthorized);
    await requireGenerativeRouteCaller(c as never);
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      traceId: "req-only",
    });
  });

  test("sets api_key auth and appScopeId from an authorized API-key snapshot", async () => {
    const { c, store } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(apiKeyAuthorized);
    const caller = await requireGenerativeRouteCaller(c as never);
    expect(store.get("authMethod")).toBe("api_key");
    expect(store.get("apiKeyId")).toBe("key-1");
    expect(caller.apiKeyId).toBe("key-1");
    expect(caller.appScopeId).toBe("app-1");
  });

  test("returns null appScopeId when the field is absent from ctx", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "authorized",
      source: "origin",
      ctx: {
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: "key-1",
      },
    });
    const caller = await requireGenerativeRouteCaller(c as never);
    expect(caller.appScopeId).toBe(null);
  });

  test("enforces the org rate limit and continues when the limiter returns null", async () => {
    const { c, executionCtx } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(apiKeyAuthorized);
    const caller = await requireGenerativeRouteCaller(c as never, {
      rateLimitEndpoint: "strict",
    });
    expect(caller.authSource).toBe("combined_cache");
    expect(inferenceRateLimitConfig).toHaveBeenCalledWith(
      apiKeyAuthorized.ctx.admission,
      "strict",
    );
    expect(enforceOrgRateLimit).toHaveBeenCalledWith("org-1", "strict", {
      cacheOnly: true,
      executionCtx,
      config: { windowMs: 1000, maxRequests: 10 },
    });
  });

  test("uses the compatibility limiter path when admission is absent", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "authorized",
      source: "cache",
      ctx: {
        userId: "user-1",
        orgId: "org-1",
        apiKeyId: null,
      },
    });
    await requireGenerativeRouteCaller(c as never, {
      rateLimitEndpoint: "standard",
    });
    expect(enforceOrgRateLimit.mock.calls[0]?.[2]).toMatchObject({
      cacheOnly: false,
    });
  });

  test("throws rate_limit_exceeded when the limiter returns 429", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(apiKeyAuthorized);
    enforceOrgRateLimit.mockResolvedValueOnce(
      new Response("slow down", { status: 429 }),
    );
    await expect(
      requireGenerativeRouteCaller(c as never, { rateLimitEndpoint: "strict" }),
    ).rejects.toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      message: "Rate limit exceeded",
    });
  });

  test("throws service_unavailable when the limiter returns a non-429 failure", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(apiKeyAuthorized);
    enforceOrgRateLimit.mockResolvedValueOnce(
      new Response("limiter down", { status: 503 }),
    );
    await expect(
      requireGenerativeRouteCaller(c as never, { rateLimitEndpoint: "strict" }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "Rate limiter is unavailable",
    });
  });

  test("fails closed when warming has no one-shot continuation", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "warming",
      hydration: Promise.resolve(sessionAuthorized),
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      message: "Authorization cache is warming; retry shortly",
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
  });

  test("does not await hydration when awaitWarmingMs is zero", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "warming",
      hydration: Promise.resolve(sessionAuthorized),
    });
    await expect(
      requireGenerativeRouteCaller(c as never, { awaitWarmingMs: 0 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      inlineContinuationDeadlineMs: 0,
    });
  });

  test("fails fast when warming has no hydration promise even with a budget", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({ kind: "warming" });
    await expect(
      requireGenerativeRouteCaller(c as never, { awaitWarmingMs: 1500 }),
    ).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
  });

  test("uses the inline origin result returned by the shared resolver", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce(sessionAuthorized);
    const caller = await requireGenerativeRouteCaller(c as never, {
      rateLimitEndpoint: "strict",
    });
    expect(caller.authSource).toBe("combined_cache");
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(enforceOrgRateLimit).toHaveBeenCalledTimes(1);
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      inlineContinuationDeadlineMs: undefined,
    });
  });

  test("surfaces a definitive continuation denial before rate limit admission", async () => {
    const { c } = workerContext();
    const denial = {
      kind: "rejected" as const,
      status: 403 as const,
      reason: "organization_inactive" as const,
    };
    resolveInferenceAuthContext.mockResolvedValueOnce(denial);

    await expect(
      requireGenerativeRouteCaller(c as never, { rateLimitEndpoint: "strict" }),
    ).rejects.toMatchObject({ status: 403, code: "access_denied" });

    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(enforceOrgRateLimit).not.toHaveBeenCalled();
  });

  test("still 503s when the warming budget expires", async () => {
    const { c } = workerContext();
    let release: (() => void) | undefined;
    const hydration = new Promise((resolve) => {
      release = () => resolve(sessionAuthorized);
    });
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "warming",
      hydration,
      continuation: hydration,
    });
    await expect(
      requireGenerativeRouteCaller(c as never, { awaitWarmingMs: 20 }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(enforceOrgRateLimit).not.toHaveBeenCalled();
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      inlineContinuationDeadlineMs: 20,
    });
    release?.();
  });

  test("maps a suspended resolution to 403 access_denied", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({ kind: "suspended" });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
      message: "Account suspended",
    });
  });

  test("maps a 403 rejection to Forbidden", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 403,
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
      message: "Forbidden",
    });
  });

  test("maps a non-403 rejection to Authentication required", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 401,
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
      message: "Authentication required",
    });
  });

  test("returns the cached account-standing reason without another lookup", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 403,
      reason: "organization_inactive",
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
      message: "Organization is inactive",
      details: { reason: "organization_inactive" },
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
  });

  test("explains an inactive cached API key without another lookup", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 403,
      reason: "credential_inactive",
    });
    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
      message: "API key is inactive",
      details: { reason: "credential_inactive" },
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
  });

  test("falls through slow_path to raw compatibility auth", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "slow_path",
      reason: "non_api_key",
    });
    const caller = await requireGenerativeRouteCaller(c as never, {
      compatibility: "raw",
    });
    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(caller.authSource).toBe("compatibility");
    expect(caller.apiKeyId).toBe("key-raw");
    expect(caller.appScopeId).toBe(null);
  });

  test("falls through slow_path to Hono compatibility auth by default", async () => {
    const { c } = workerContext({ apiKeyId: "compat-key" });
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "slow_path",
      reason: "mobile_api_key",
    });
    const caller = await requireGenerativeRouteCaller(c as never);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(caller).toEqual({
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: "compat-key",
      authSource: "compatibility",
      appScopeId: null,
    });
  });
});
