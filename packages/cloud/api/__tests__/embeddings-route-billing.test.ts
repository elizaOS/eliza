/**
 * Exercises the real embeddings route and idempotent reservation settler with
 * deterministic auth, provider and billing boundaries. Covers deferred billing,
 * admission, attribution, vector fidelity and settlement after failures.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { APICallError } from "ai";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as languageModelActual from "@/lib/providers/language-model";
import type { EmbeddingsResponse } from "@elizaos/cloud-sdk";
import { BGE_SMALL_VECTOR_SPACE } from "@elizaos/core";
import { createCloudflareEmbeddingModel } from "@/lib/providers/cloudflare-embeddings";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as apiKeysActual from "@/lib/services/api-keys";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";
import * as admissionActual from "@/lib/services/organization-inference-admission";
import * as usageActual from "@/lib/services/usage";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";

const aiActual = require("ai") as Record<string, unknown>;
const reconcile = mock(async (_actualCost: number) => undefined);
const reservation = { reservedAmount: 0.01, reconcile };

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";

const EMBEDDING = [0.0125, -0.5, 0.333333, 1, -1, 0];

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

const validateApiKey = mock();
mock.module("@/lib/services/api-keys", () => ({
  ...apiKeysActual,
  apiKeysService: { ...apiKeysActual.apiKeysService, validateApiKey },
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

// Provider config: pretend an embedding provider is configured and hand back a
// dummy model object (the embed mock ignores it).
let embeddingSource: "openai" | "cloudflare" = "openai";
mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasTextEmbeddingProviderConfigured: () => true,
  getTextEmbeddingModel: () =>
    embeddingSource === "cloudflare"
      ? createCloudflareEmbeddingModel("a".repeat(32), "test-workers-ai-token")
      : ({} as never),
  resolveEmbeddingProviderSource: () => embeddingSource,
  getAiProviderConfigurationError: () => "AI services are not configured",
  resolvePassthroughEmbeddingsUpstream: () => null,
}));

const reserveCredits = mock();
const billUsage = mock();
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits,
  billUsage,
}));

mock.module("@/lib/services/organization-inference-admission", () => ({
  ...admissionActual,
  admitOrganizationInference: async (params: {
    context: Record<string, unknown>;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    affiliateCode?: string | null;
  }) => {
    const reservation = await reserveCredits(
      { ...params.context, affiliateCode: params.affiliateCode ?? undefined },
      params.estimatedInputTokens,
      params.estimatedOutputTokens,
    );
    const settle = createCreditReservationSettler(reservation);
    return {
      mode: "synchronous_reservation",
      settle,
      settleUnknown: () => settle(reservation.reservedAmount),
      reservation: {
        reservedAmount: reservation.reservedAmount,
        reconcile: async (actualCost: number) =>
          (await settle(actualCost)) ?? undefined,
      },
    };
  },
}));

const usageCreate = mock();
mock.module("@/lib/services/usage", () => ({
  ...usageActual,
  usageService: { ...usageActual.usageService, create: usageCreate },
}));

// The embedder itself — mock the `ai` package's `embed`/`embedMany`.
const realEmbed: typeof import("ai").embed = require("ai").embed;
const realEmbedMany: typeof import("ai").embedMany = require("ai").embedMany;
const embed = mock();
const embedMany = mock();
mock.module("ai", () => ({
  ...aiActual,
  embed,
  embedMany,
}));

const embeddingsRoute = (await import("../v1/embeddings/route")).default;

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/services/api-keys", () => apiKeysActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthActual,
  );
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module(
    "@/lib/services/organization-inference-admission",
    () => admissionActual,
  );
  mock.module("@/lib/services/usage", () => usageActual);
});

/** Collects the promises scheduled via executionCtx.waitUntil. */
function makeExecutionCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(Promise.resolve(p));
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    scheduled,
  };
}

function post(body: unknown, ctx?: ExecutionContext) {
  return embeddingsRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    {},
    ctx,
  );
}

function makeBilling(actual: number) {
  return {
    inputCost: actual,
    outputCost: 0,
    totalCost: actual,
    baseInputCost: actual,
    baseOutputCost: 0,
    baseTotalCost: actual,
    platformMarkup: 0,
    inputTokens: 5,
    outputTokens: 0,
    totalTokens: 5,
    markupApplied: true,
  };
}

beforeEach(() => {
  embeddingSource = "openai";
  requireUserOrApiKeyWithOrg.mockReset();
  resolveInferenceAuthContext.mockReset();
  validateApiKey.mockReset();
  enforceOrgRateLimit.mockReset();
  reserveCredits.mockReset();
  reconcile.mockClear();
  billUsage.mockReset();
  usageCreate.mockReset();
  embed.mockReset();
  embedMany.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", API_KEY_ID);
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });
  resolveInferenceAuthContext.mockResolvedValue({
    kind: "authorized",
    source: "cache",
    ctx: {
      userId: USER,
      orgId: ORG,
      apiKeyId: API_KEY_ID,
    },
  });
  enforceOrgRateLimit.mockResolvedValue(null);
  reserveCredits.mockResolvedValue(reservation);
  billUsage.mockResolvedValue(makeBilling(0.001));
  usageCreate.mockResolvedValue({ id: "usage-1" });
  embed.mockResolvedValue({ embedding: EMBEDDING, usage: { tokens: 5 } });
  embedMany.mockResolvedValue({
    embeddings: [EMBEDDING, EMBEDDING],
    usage: { tokens: 10 },
  });
});

type AppCtx = { set: (k: string, v: unknown) => void };

describe("POST /api/v1/embeddings — deferred billing", () => {
  test("billUsage is scheduled via waitUntil, not awaited before the response", async () => {
    let releaseBilling!: () => void;
    const billingGate = new Promise<void>((resolve) => {
      releaseBilling = resolve;
    });
    billUsage.mockImplementation(async () => {
      await billingGate;
      return makeBilling(0.001);
    });

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );

    expect(res.status).toBe(200);
    expect(scheduled.length).toBe(1);

    releaseBilling();
    await Promise.all(scheduled);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(0.001);
    expect(usageCreate).toHaveBeenCalledTimes(1);
  });

  test("embed is called before billUsage (billing is post-embed)", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    await post({ model: "text-embedding-3-small", input: "hi" }, ctx);
    await Promise.all(scheduled);

    expect(embed).toHaveBeenCalledTimes(1);
    expect(billUsage).toHaveBeenCalledTimes(1);
    const embedOrder = embed.mock.invocationCallOrder[0];
    const billOrder = billUsage.mock.invocationCallOrder[0];
    expect(embedOrder).toBeLessThan(billOrder);
  });
});

describe("POST /api/v1/embeddings — insufficient-credits guard", () => {
  test("returns 402 BEFORE embedding when the reserve guard rejects", async () => {
    reserveCredits.mockRejectedValue(
      new aiBillingActual.InsufficientCreditsError(0.5, 0.01),
    );

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("insufficient_balance");

    expect(embed).not.toHaveBeenCalled();
    expect(embedMany).not.toHaveBeenCalled();
    expect(billUsage).not.toHaveBeenCalled();
    expect(scheduled.length).toBe(0);
  });
});

describe("POST /api/v1/embeddings — single key validation", () => {
  test("cached inference auth skips the Hono auth helper and uses the cached api key id", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );
    await Promise.all(scheduled);

    expect(res.status).toBe(200);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(billUsage.mock.calls[0][0].apiKeyId).toBe(API_KEY_ID);
    expect(usageCreate.mock.calls[0][0].api_key_id).toBe(API_KEY_ID);
  });
});

describe("POST /api/v1/embeddings — returned vectors unchanged", () => {
  test("single input: response embedding is byte-identical to the embedder output", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );
    await Promise.all(scheduled);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ object: string; embedding: number[]; index: number }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].index).toBe(0);
    expect(body.data[0].embedding).toEqual(EMBEDDING);
    expect(body.usage).toEqual({ prompt_tokens: 5, total_tokens: 5 });
  });

  test("array input: each response embedding matches the embedder output", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: ["a", "b"] },
      ctx,
    );
    await Promise.all(scheduled);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    expect(body.data).toHaveLength(2);
    expect(body.data[0].embedding).toEqual(EMBEDDING);
    expect(body.data[1].embedding).toEqual(EMBEDDING);
    expect(body.data[1].index).toBe(1);
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embed).not.toHaveBeenCalled();
  });
});

function makeApiCallError(statusCode: number) {
  return new APICallError({
    message: `provider returned ${statusCode}`,
    url: "https://provider.example/v1/embeddings",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

describe("embeddings settlement", () => {
  test.each([
    ["hi", 429, 0],
    ["hi", 503, 0.01],
    [["a", "b"], 429, 0],
  ] as const)(
    "provider error for %j with status %i settles %f once",
    async (input, status, cost) => {
      const provider = Array.isArray(input) ? embedMany : embed;
      provider.mockRejectedValue(makeApiCallError(status));
      const { ctx, scheduled } = makeExecutionCtx();
      const response = await post(
        { model: "text-embedding-3-small", input },
        ctx,
      );

      expect(response.status).toBe(status);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(billUsage).not.toHaveBeenCalled();
      expect(scheduled).toHaveLength(1);
      await Promise.all(scheduled);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(cost);
    },
  );

  test("reserve failure returns 500 before provider dispatch without settlement", async () => {
    reserveCredits.mockRejectedValue(new Error("db down"));
    const { ctx, scheduled } = makeExecutionCtx();
    const response = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );

    expect(response.status).toBe(500);
    expect(embed).not.toHaveBeenCalled();
    expect(billUsage).not.toHaveBeenCalled();
    await Promise.all(scheduled);
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("billing and route settlement share the same idempotent reservation", async () => {
    billUsage.mockImplementation(
      async (_context, _usage, admittedReservation) => {
        expect(admittedReservation).not.toBe(reservation);
        await admittedReservation.reconcile(0.003);
        return makeBilling(0.003);
      },
    );
    const { ctx, scheduled } = makeExecutionCtx();
    const response = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );

    expect(response.status).toBe(200);
    await Promise.all(scheduled);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(0.003);
  });

  test("unknown cost after provider success settles the estimate once", async () => {
    billUsage.mockRejectedValue(new Error("calculateCost exploded"));
    const { ctx, scheduled } = makeExecutionCtx();
    const response = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );

    expect(response.status).toBe(200);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(reservation.reservedAmount);
    expect(usageCreate).not.toHaveBeenCalled();
  });

  test("usage write failure after settlement cannot refund successful inference", async () => {
    billUsage.mockResolvedValue(makeBilling(0.004));
    usageCreate.mockRejectedValue(new Error("usage table write failed"));
    const { ctx, scheduled } = makeExecutionCtx();
    const response = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );

    expect(response.status).toBe(200);
    await Promise.all(scheduled);
    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(0.004);
  });
});

test("rejects oversized BGE input before credits or upstream dispatch", async () => {
  embeddingSource = "cloudflare";
  const response = await post({
    model: "bge-small-en-v1.5",
    input: ["Short source", "A meeting about database backups. ".repeat(200)],
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "EMBEDDING_INPUT_TOO_LARGE", param: "input" },
  });
  expect(reserveCredits).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
  expect(embedMany).not.toHaveBeenCalled();
});

test("returns the actual BGE adapter's representation with its normalized vectors", async () => {
  embeddingSource = "cloudflare";
  let requestBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = new Proxy(originalFetch, {
    async apply(_target, _receiver, [_input, init]: Parameters<typeof fetch>) {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        result: { data: [[3, 4, ...Array(382).fill(0)]] },
      });
    },
  });
  embed.mockImplementation(realEmbed);
  try {
    const { ctx, scheduled } = makeExecutionCtx();
    const response = await post(
      { model: "bge-small-en-v1.5", input: "Complete source text" },
      ctx,
    );
    await Promise.all(scheduled);
    expect(response.status).toBe(200);
    const result = (await response.json()) as EmbeddingsResponse;
    expect(result.embedding_space).toBe(BGE_SMALL_VECTOR_SPACE);
    expect(result.data[0].embedding).toEqual([0.6, 0.8, ...Array(382).fill(0)]);
    expect(requestBody).toEqual({
      text: ["Complete source text"],
      pooling: "cls",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retains the reservation when a later BGE batch is rejected after accepted work", async () => {
  embeddingSource = "cloudflare";
  const reconcile = mock(async () => undefined);
  reserveCredits.mockResolvedValue({ reservedAmount: 0.01, reconcile });
  embedMany.mockImplementation(realEmbedMany);
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = new Proxy(originalFetch, {
    async apply(_target, _receiver, [_input, init]: Parameters<typeof fetch>) {
      requests += 1;
      if (requests > 1)
        return new Response("Rejected second batch", { status: 422 });
      const body = JSON.parse(String(init?.body)) as { text: string[] };
      return Response.json({
        success: true,
        result: { data: body.text.map(() => [1, ...Array(383).fill(0)]) },
      });
    },
  });
  try {
    const { ctx, scheduled } = makeExecutionCtx();
    const response = await post(
      {
        model: "bge-small-en-v1.5",
        input: Array(101).fill("Complete source text"),
      },
      ctx,
    );
    await Promise.all(scheduled);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(requests).toBe(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(0.01);
    expect(billUsage).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
