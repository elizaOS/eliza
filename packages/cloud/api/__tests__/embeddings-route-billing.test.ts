/**
 * Tests for POST /api/v1/embeddings — the per-call latency cuts (#47).
 *
 * The route was reworked so the embed/vector return is no longer blocked by
 * billing DB round-trips, and so a single API-key validation (done by the auth
 * helper) is reused instead of a second per-request lookup. These tests pin the
 * load-bearing invariants of that change:
 *
 *   1. billUsage runs via executionCtx.waitUntil — it is SCHEDULED, not awaited
 *      before the response is sent (so the vectors return without waiting on the
 *      billing/usage DB writes), but it STILL RUNS (billing correctness).
 *   2. The terminal insufficient-credits guard still fires BEFORE embedding —
 *      a caller with no credits gets a 402 and the embed call never happens.
 *   3. The API key is validated exactly once (by the auth helper). The route
 *      itself never calls apiKeysService.validateApiKey a second time.
 *   4. The returned vectors are byte-for-byte what the embedder produced.
 *
 * Everything is mocked at the module boundary so the suite runs without I/O.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
// Spread the real modules: bun's `mock.module` replaces the registry entry
// process-wide, so dropping the other real exports would strand later test files
// that import from these modules. afterAll restores them.
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as apiKeysActual from "@/lib/services/api-keys";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";
import * as usageActual from "@/lib/services/usage";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";

// A deterministic, recognizable vector so we can assert byte-equality.
const EMBEDDING = [0.0125, -0.5, 0.333333, 1, -1, 0];

// --- Auth: validates the key ONCE and exposes apiKeyId on the context. -------
const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

// Spy the api-keys service so we can prove the ROUTE never does a second lookup.
const validateApiKey = mock();
mock.module("@/lib/services/api-keys", () => ({
  ...apiKeysActual,
  apiKeysService: { ...apiKeysActual.apiKeysService, validateApiKey },
}));

// Rate limiting is not under test — make the org gate a no-op (no Redis).
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
mock.module("@/lib/providers/language-model", () => ({
  hasTextEmbeddingProviderConfigured: () => true,
  getTextEmbeddingModel: () => ({}) as never,
  resolveEmbeddingProviderSource: () => "openai",
  getAiProviderConfigurationError: () => "AI services are not configured",
}));

// Billing surface.
const reserveCredits = mock();
const billUsage = mock();
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits,
  billUsage,
}));

const usageCreate = mock();
mock.module("@/lib/services/usage", () => ({
  ...usageActual,
  usageService: { ...usageActual.usageService, create: usageCreate },
}));

// The embedder itself — mock the `ai` package's `embed`/`embedMany`.
const embed = mock();
const embedMany = mock();
mock.module("ai", () => ({
  ...(require("ai") as object),
  embed,
  embedMany,
}));

// Import the route AFTER the mocks so it binds to the stubs.
const embeddingsRoute = (await import("../v1/embeddings/route")).default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/services/api-keys", () => apiKeysActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthActual,
  );
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
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

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  resolveInferenceAuthContext.mockReset();
  validateApiKey.mockReset();
  enforceOrgRateLimit.mockReset();
  reserveCredits.mockReset();
  billUsage.mockReset();
  usageCreate.mockReset();
  embed.mockReset();
  embedMany.mockReset();

  // Auth helper validates the key once and surfaces its id on the context —
  // exactly as the real requireUserOrApiKeyWithOrg does.
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
    kind: "slow_path",
    reason: "non_api_key",
  });
  enforceOrgRateLimit.mockResolvedValue(null);
  reserveCredits.mockResolvedValue({
    reservedAmount: 0.01,
    reconcile: mock(async () => undefined),
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
    embeddings: [EMBEDDING, EMBEDDING],
    usage: { tokens: 10 },
  });
});

// Minimal context shape used by the auth mock's c.set(...).
type AppCtx = { set: (k: string, v: unknown) => void };

describe("POST /api/v1/embeddings — deferred billing", () => {
  test("billUsage is scheduled via waitUntil, not awaited before the response", async () => {
    // Gate billUsage on a manual signal so we can prove the response returns
    // BEFORE billing completes. If the route awaited billUsage inline, the
    // request would hang here forever.
    let releaseBilling!: () => void;
    const billingGate = new Promise<void>((resolve) => {
      releaseBilling = resolve;
    });
    billUsage.mockImplementation(async () => {
      await billingGate;
      return {
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
      };
    });

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );

    // Response came back even though billUsage has not resolved yet.
    expect(res.status).toBe(200);
    // Billing was scheduled on the execution context (deferred), not inline.
    expect(scheduled.length).toBe(1);

    // Now let the deferred billing finish and confirm it actually ran.
    releaseBilling();
    await Promise.all(scheduled);
    expect(billUsage).toHaveBeenCalledTimes(1);
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

    // The guard is terminal: no embedding, no billing, nothing deferred.
    expect(embed).not.toHaveBeenCalled();
    expect(embedMany).not.toHaveBeenCalled();
    expect(billUsage).not.toHaveBeenCalled();
    expect(scheduled.length).toBe(0);
  });
});

describe("POST /api/v1/embeddings — single key validation", () => {
  test("the route does not re-validate the API key (no second DB lookup)", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    await post({ model: "text-embedding-3-small", input: "hi" }, ctx);
    await Promise.all(scheduled);

    // The auth helper validated the key once; the route reads apiKeyId from the
    // context and must NOT call apiKeysService.validateApiKey again.
    expect(validateApiKey).not.toHaveBeenCalled();

    // And the apiKeyId from context flows into billing + usage attribution.
    expect(billUsage.mock.calls[0][0].apiKeyId).toBe(API_KEY_ID);
    expect(usageCreate.mock.calls[0][0].api_key_id).toBe(API_KEY_ID);
  });

  test("cached inference auth skips the Hono auth helper and uses the cached api key id", async () => {
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "authorized",
      source: "cache",
      ctx: {
        v: 1,
        cachedAt: Date.now(),
        userId: USER,
        orgId: ORG,
        apiKeyId: API_KEY_ID,
        keyHash: "key-hash",
      },
    });

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
    // Byte-for-byte equality with what the embedder returned.
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
