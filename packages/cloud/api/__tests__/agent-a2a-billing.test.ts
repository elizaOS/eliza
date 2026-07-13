/**
 * Agent A2A billing invariants for monetized agents — companion to
 * agent-mcp-billing.test.ts.
 *
 * Regression for #10266: the A2A chat path settles the consumer org with
 * reservation.reconcile(actualTotal), THEN records creator earnings in the same
 * try. recordCreatorEarnings can throw on a transient DB error; the pre-fix code
 * let it reach the outer catch, which ran the NON-idempotent reconcile(0) —
 * double-refunding the WHOLE reservation (free inference + a net credit grant)
 * and returning a -32000 error. The degraded response now preserves the model
 * result with an explicit warning and reconciles exactly once.
 *
 * `handleChat` is module-private, so we drive it through the exported Hono app's
 * POST handler (method "chat"), mounted under `/agents/:id/a2a` so the `:id`
 * param resolves (mirrors app-charge-public-route.test.ts).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
// `mock.module` is process-global: spread the real auth module so this file's
// partial mock (only `requireUserOrApiKeyWithOrg`) does not drop the other auth
// exports (e.g. `requireUserOrApiKey`) for later test files in the same run.
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const USER_ID = "00000000-0000-4000-8000-0000000000bb";

const getLanguageModel = mock((model: string) => ({ model }));
mock.module("@/lib/providers/language-model", () => ({
  getLanguageModel,
}));

const streamText = mock();
mock.module("ai", () => ({
  streamText,
}));

const estimateRequestCost = mock();
const calculateCost = mock();
const getProviderFromModel = mock((model: string) =>
  model.startsWith("anthropic/") ? "anthropic" : "openai",
);
mock.module("@/lib/pricing", () => ({
  calculateCost,
  estimateRequestCost,
  getProviderFromModel,
}));

// Settable so a test can drive a non-null admitted thinking budget through the
// mounted route (#16147). Resolver precedence and clamping have their own tests;
// here it stands in for "whatever budget the route resolved to".
const resolveAnthropicThinkingBudgetTokens = mock((): number | null => null);
const mergeAnthropicCotProviderOptions = mock(
  (): Record<string, unknown> => ({}),
);
mock.module("@/lib/providers/anthropic-thinking", () => ({
  getAnthropicCotEnv: () => ({}),
  mergeAnthropicCotProviderOptions,
  parseThinkingBudgetFromCharacterSettings: () => null,
  resolveAnthropicThinkingBudgetTokens,
}));

const recordCreatorEarnings = mock();
mock.module("@/lib/services/agent-monetization", () => ({
  agentMonetizationService: { recordCreatorEarnings },
}));

const reserve = mock();
const charactersGetById = mock();
class InsufficientCreditsError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
    public readonly reason?: string,
  ) {
    super("Insufficient credits");
  }
}
mock.module("@/lib/services/credits", () => ({
  creditsService: { reserve },
  InsufficientCreditsError,
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { getById: charactersGetById },
}));

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const { default: a2aRoute } = await import("../agents/[id]/a2a/route");

const app = new Hono();
app.route("/agents/:id/a2a", a2aRoute);

function textStream(text: string) {
  return (async function* stream() {
    yield text;
  })();
}

function makeCharacter() {
  return {
    id: "agent-1",
    name: "Markup Agent",
    user_id: "owner-1",
    organization_id: "creator-org",
    is_public: true,
    a2a_enabled: true,
    monetization_enabled: true,
    inference_markup_percentage: "500",
    system: null,
    bio: "Helpful.",
    category: null,
    tags: [],
    settings: {},
  };
}

function makeReservation(reconcileResult: {
  adjustmentType: "none" | "refund" | "overage" | "uncollected_overage";
}) {
  const reconcile = mock(async (actualCost: number) => ({
    reservedAmount: 0.06,
    actualCost,
    reservationTransactionId: "reservation-1",
    settlementTransactionIds: [],
    ...reconcileResult,
  }));
  reserve.mockResolvedValue({
    reservedAmount: 0.06,
    reservationTransactionId: "reservation-1",
    reconcile,
  });
  return reconcile;
}

function callChat(model = "gpt-5-mini") {
  return app.request(
    "/agents/agent-1/a2a",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "chat",
        params: {
          model,
          messages: [{ role: "user", content: "hello" }],
        },
        id: "rpc-1",
      }),
    },
    // Worker Bindings (c.env): the route reads ANTHROPIC_COT_* off it.
    {},
  );
}

beforeEach(() => {
  getLanguageModel.mockClear();
  streamText.mockReset();
  resolveAnthropicThinkingBudgetTokens.mockReset();
  resolveAnthropicThinkingBudgetTokens.mockReturnValue(null);
  mergeAnthropicCotProviderOptions.mockReset();
  mergeAnthropicCotProviderOptions.mockReturnValue({});
  estimateRequestCost.mockReset();
  calculateCost.mockReset();
  getProviderFromModel.mockClear();
  recordCreatorEarnings.mockReset();
  reserve.mockReset();
  charactersGetById.mockReset();
  requireUserOrApiKeyWithOrg.mockReset();

  charactersGetById.mockResolvedValue(makeCharacter());
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: USER_ID,
    organization_id: ORG_ID,
  });
  estimateRequestCost.mockResolvedValue(0.01);
  calculateCost.mockResolvedValue({ totalCost: 0.01 });
  streamText.mockResolvedValue({
    textStream: textStream("hello from model"),
    usage: Promise.resolve({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    }),
  });
  recordCreatorEarnings.mockResolvedValue(undefined);
});

describe("Agent A2A billing", () => {
  test("settles once and records creator earnings on the happy path", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });

    const response = await callChat();
    const body = (await response.json()) as {
      result?: { content: string };
      error?: { code: number };
    };

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBeCloseTo(0.06, 12);
    expect(recordCreatorEarnings).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        earnings: 0.05,
        consumerOrgId: ORG_ID,
        protocol: "a2a",
      }),
    );
    expect(body.error).toBeUndefined();
    expect(body.result?.content).toBe("hello from model");
  });

  // #16147: the output ceiling used to price/reserve must be the exact value
  // capped on the provider call, for every resolved thinking budget including
  // none. Here we prove the route forwards the resolved value to both sinks.
  test.each([
    [null, 500],
    [1024, 1524],
    [8000, 8500],
  ] as const)("prices and caps the provider at one admitted ceiling (budget=%p)", async (budget, expectedCap) => {
    makeReservation({ adjustmentType: "none" });
    resolveAnthropicThinkingBudgetTokens.mockReturnValue(budget);

    const response = await callChat("anthropic/claude-opus-4-5");
    expect(response.status).toBe(200);

    // Reserved with this exact ceiling (3rd arg to estimateRequestCost)...
    expect(estimateRequestCost.mock.calls[0]?.[2]).toBe(expectedCap);
    // ...and the provider is capped at the identical value — never omitted.
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(streamText.mock.calls[0]?.[0]?.maxOutputTokens).toBe(expectedCap);
    expect(streamText.mock.calls[0]?.[0]?.maxOutputTokens).toBe(
      estimateRequestCost.mock.calls[0]?.[2],
    );
  });

  test("insufficient credits stop the request before provider dispatch", async () => {
    reserve.mockRejectedValue(new InsufficientCreditsError(0.5, 0.1));

    const response = await callChat("anthropic/claude-opus-4-5");
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(body.error?.code).toBe(-32003);
    expect(body.error?.message).toContain("Insufficient credits");
    expect(streamText).not.toHaveBeenCalled();
    expect(recordCreatorEarnings).not.toHaveBeenCalled();
  });

  test.each([
    ["missing messages", {}],
    ["non-array messages", { messages: "hello" }],
    ["unsupported role", { messages: [{ role: "tool", content: "hello" }] }],
    ["empty content", { messages: [{ role: "user", content: "" }] }],
  ])("rejects invalid chat params before billing: %s", async (_label, params) => {
    const response = await app.request("/agents/agent-1/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "chat",
        params,
        id: "invalid-rpc",
      }),
    });
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe(-32602);
    expect(reserve).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("missing provider usage fails and refunds instead of fabricating zero metering", async () => {
    const reconcile = makeReservation({ adjustmentType: "refund" });
    streamText.mockResolvedValue({
      textStream: textStream("unmetered output"),
      usage: Promise.resolve({
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      }),
    });

    const response = await callChat();
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(body.error?.code).toBe(-32000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(0);
    expect(recordCreatorEarnings).not.toHaveBeenCalled();
  });

  // Regression for #10266 (A2A side).
  test("post-settlement earnings failure does not double-refund the reservation", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });
    recordCreatorEarnings.mockRejectedValue(
      new Error("transient DB error while recording earnings"),
    );

    const response = await callChat();
    const body = (await response.json()) as {
      result?: {
        content: string;
        warnings?: Array<{ code: string; message: string }>;
      };
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(200);

    // Reconciled EXACTLY ONCE with the real settled total — never the outer
    // catch's double-refund reconcile(0).
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBeCloseTo(0.06, 12);

    // Earnings attempted (and failed) but the request still returns the
    // successful settlement, not the -32000 outer-catch error.
    expect(recordCreatorEarnings).toHaveBeenCalledTimes(1);
    expect(body.error).toBeUndefined();
    expect(body.result?.content).toBe("hello from model");
    expect(body.result?.warnings).toEqual([
      {
        code: "CREATOR_EARNINGS_UNAVAILABLE",
        message: "Creator earnings could not be recorded",
      },
    ]);
  });
});
