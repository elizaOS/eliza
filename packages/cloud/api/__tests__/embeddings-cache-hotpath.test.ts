/**
 * Proves the Worker embeddings route reaches provider dispatch using only
 * cache-resolved authorization, rate policy, pricing, and credit admission.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";
import * as admissionActual from "@/lib/services/organization-inference-admission";
import * as usageActual from "@/lib/services/usage";

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const EMBEDDING = [0.25, -0.5, 1];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

const enforceOrgRateLimit = mock();
mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit,
}));

const resolveInferenceAuthContext = mock();
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthActual,
  resolveInferenceAuthContext,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getAiProviderConfigurationError: () => "AI services are not configured",
  getTextEmbeddingModel: () => ({}) as never,
  hasTextEmbeddingProviderConfigured: () => true,
  resolveEmbeddingProviderSource: () => "openai",
  resolvePassthroughEmbeddingsUpstream: () => null,
}));

const settleAdmission = mock(async () => null);
const admitOrganizationInference = mock();
mock.module("@/lib/services/organization-inference-admission", () => ({
  ...admissionActual,
  admitOrganizationInference,
}));

const billUsage = mock();
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  billUsage,
}));

const usageCreate = mock();
mock.module("@/lib/services/usage", () => ({
  ...usageActual,
  usageService: { ...usageActual.usageService, create: usageCreate },
}));

const embed = mock();
const embedMany = mock();
mock.module("ai", () => ({
  ...aiActual,
  embed,
  embedMany,
}));

const embeddingsRoute = (await import("../v1/embeddings/route")).default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthActual,
  );
  mock.module(
    "@/lib/services/organization-inference-admission",
    () => admissionActual,
  );
  mock.module("@/lib/services/usage", () => usageActual);
  mock.module("ai", () => aiActual);
});

function makeExecutionCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        scheduled.push(Promise.resolve(promise));
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    scheduled,
  };
}

function post(ctx: ExecutionContext) {
  return embeddingsRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "cache-only hot path",
      }),
    },
    {},
    ctx,
  );
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  enforceOrgRateLimit.mockReset();
  resolveInferenceAuthContext.mockReset();
  admitOrganizationInference.mockReset();
  settleAdmission.mockClear();
  billUsage.mockReset();
  usageCreate.mockReset();
  embed.mockReset();
  embedMany.mockReset();

  resolveInferenceAuthContext.mockResolvedValue({
    kind: "authorized",
    source: "cache",
    ctx: {
      v: 1,
      cachedAt: Date.now(),
      userId: USER,
      orgId: ORG,
      apiKeyId: API_KEY_ID,
      keyHash: "cached-key-hash",
    },
  });
  enforceOrgRateLimit.mockResolvedValue(null);
  admitOrganizationInference.mockResolvedValue({
    mode: "deferred_kv_ledger",
    settle: settleAdmission,
    settleUnknown: settleAdmission,
  });
  billUsage.mockResolvedValue({
    inputCost: 0.001,
    outputCost: 0,
    totalCost: 0.001,
    baseInputCost: 0.001,
    baseOutputCost: 0,
    baseTotalCost: 0.001,
    platformMarkup: 0,
    inputTokens: 5,
    outputTokens: 0,
    totalTokens: 5,
    markupApplied: true,
  });
  usageCreate.mockResolvedValue({ id: "usage-1" });
  embed.mockResolvedValue({ embedding: EMBEDDING, usage: { tokens: 5 } });
  embedMany.mockResolvedValue({
    embeddings: [EMBEDDING],
    usage: { tokens: 5 },
  });
});

describe("POST /api/v1/embeddings Worker cache hot path", () => {
  test("enabled Worker admission rejects a missing execution context without authoritative fallback", async () => {
    const response = await embeddingsRoute.request(
      "/",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer eliza_test_key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "cache-only hot path",
        }),
      },
      { INFERENCE_DEFERRED_ADMISSION: "true" },
    );

    expect(response.status).toBe(503);
    expect(resolveInferenceAuthContext).not.toHaveBeenCalled();
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  test("warm API-key auth reaches provider dispatch without joining authoritative admission", async () => {
    const authoritativeAdmission = Promise.withResolvers<void>();
    admitOrganizationInference.mockImplementation(
      async (params: {
        executionCtx?: { waitUntil(promise: Promise<unknown>): void };
      }) => {
        params.executionCtx?.waitUntil(authoritativeAdmission.promise);
        return {
          mode: "deferred_kv_ledger",
          settle: settleAdmission,
          settleUnknown: settleAdmission,
        };
      },
    );
    const { ctx, scheduled } = makeExecutionCtx();

    const outcome = await Promise.race([
      Promise.resolve(post(ctx)).then((response) => ({
        kind: "response" as const,
        response,
      })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 100),
      ),
    ]);

    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") {
      throw new Error("provider dispatch joined authoritative admission");
    }
    expect(outcome.response.status).toBe(200);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(enforceOrgRateLimit).toHaveBeenCalledWith(ORG, "embeddings", {
      cacheOnly: true,
      executionCtx: ctx,
    });
    expect(admitOrganizationInference).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: API_KEY_ID,
        executionCtx: ctx,
        context: expect.objectContaining({
          organizationId: ORG,
          userId: USER,
          apiKeyId: API_KEY_ID,
        }),
      }),
    );
    const admissionParams = admitOrganizationInference.mock.calls[0]?.[0] as {
      context: { requestId: string };
    };
    expect(admissionParams.context.requestId).toMatch(UUID_RE);

    authoritativeAdmission.resolve();
    await Promise.all(scheduled);
  });

  test("warm Steward session stays cache-only and attributes no API key", async () => {
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "authorized",
      source: "steward_session",
      ctx: {
        v: 1,
        cachedAt: Date.now(),
        userId: USER,
        orgId: ORG,
        apiKeyId: null,
        stewardUserIdHash: "session-subject-hash",
      },
    });
    const { ctx, scheduled } = makeExecutionCtx();

    const response = await post(ctx);
    expect(response.status).toBe(200);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(admitOrganizationInference).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: null,
        context: expect.objectContaining({ apiKeyId: null }),
      }),
    );

    await Promise.all(scheduled);
    expect(billUsage.mock.calls[0]?.[0]).toMatchObject({ apiKeyId: null });
    expect(usageCreate.mock.calls[0]?.[0]).toMatchObject({ api_key_id: null });
  });

  test("cold auth returns retryable 503 while hydration remains under waitUntil", async () => {
    const authHydration = Promise.withResolvers<void>();
    resolveInferenceAuthContext.mockImplementationOnce(
      async (
        _request: Request,
        options: {
          executionCtx?: { waitUntil(promise: Promise<unknown>): void };
        },
      ) => {
        options.executionCtx?.waitUntil(authHydration.promise);
        return { kind: "warming", cacheRead: "miss" };
      },
    );
    const { ctx, scheduled } = makeExecutionCtx();

    const outcome = await Promise.race([
      Promise.resolve(post(ctx)).then((response) => ({
        kind: "response" as const,
        response,
      })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 100),
      ),
    ]);

    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response")
      throw new Error("auth path joined hydration");
    expect(outcome.response.status).toBe(503);
    await expect(outcome.response.json()).resolves.toMatchObject({
      error: { code: "auth_cache_warming" },
    });
    expect(scheduled).toHaveLength(1);
    expect(enforceOrgRateLimit).not.toHaveBeenCalled();
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();

    authHydration.resolve();
    await scheduled[0];
  });

  test("cold org-rate policy is an explicit retryable 503 before admission", async () => {
    enforceOrgRateLimit.mockRejectedValueOnce(
      new rateLimitActual.OrgRateLimitCacheNotReadyError("warming", "miss"),
    );
    const { ctx, scheduled } = makeExecutionCtx();

    const response = await post(ctx);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "rate_limit_cache_warming" },
    });
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    await Promise.all(scheduled);
  });

  test("cold pricing or balance admission is retryable and never dispatches", async () => {
    admitOrganizationInference.mockRejectedValueOnce(
      new admissionActual.InferencePricingCacheWarmingError(
        new Error("cold pricing") as never,
      ),
    );
    const { ctx, scheduled } = makeExecutionCtx();

    const response = await post(ctx);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "inference_admission_cache_warming" },
    });
    expect(embed).not.toHaveBeenCalled();
    await Promise.all(scheduled);
  });

  test("cached insufficient balance returns 402 before provider dispatch", async () => {
    admitOrganizationInference.mockRejectedValueOnce(
      new aiBillingActual.InsufficientCreditsError(
        0.005,
        0.001,
        "cached_balance_gate",
      ),
    );
    const { ctx, scheduled } = makeExecutionCtx();

    const response = await post(ctx);
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "insufficient_balance" },
    });
    expect(embed).not.toHaveBeenCalled();
    await Promise.all(scheduled);
  });
});
