/**
 * Agent MCP billing invariants for monetized agents.
 *
 * The route must reserve the marked-up estimate up front and must not credit
 * creator earnings unless final reconciliation confirms the consumer charge was
 * collected.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
// `mock.module` is process-global: spread the real auth module so this file's
// partial mock (only `requireUserOrApiKeyWithOrg`) does not drop the other auth
// exports (e.g. `requireUserOrApiKey`) for later test files in the same run.
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const USER_ID = "00000000-0000-4000-8000-0000000000bb";

const languageModel = mock((model: string) => ({ model }));
mock.module("@ai-sdk/gateway", () => ({
  gateway: { languageModel },
}));

const streamText = mock();
mock.module("ai", () => ({
  streamText,
}));

const estimateRequestCost = mock();
const calculateCost = mock();
const getProviderFromModel = mock(() => "openai");
mock.module("@/lib/pricing", () => ({
  calculateCost,
  estimateRequestCost,
  getProviderFromModel,
}));

// Settable so a test can drive the admitted thinking budget through the route
// (#16148). The resolver's own clamping is unit-tested elsewhere; here it stands
// in for "whatever budget the route resolved to".
const resolveAnthropicThinkingBudgetTokens = mock((): number | null => null);
const mergeAnthropicCotProviderOptions = mock(
  (
    _model: string,
    _env: unknown,
    _budget?: number,
  ): Record<string, unknown> => ({}),
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
  charactersService: { getById: mock() },
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg: mock(),
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

const { handleToolCall } = await import("../agents/[id]/mcp/route");

function textStream(text: string) {
  return (async function* stream() {
    yield text;
  })();
}

function makeContext() {
  return {
    env: {},
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }),
  };
}

function makeCharacter() {
  return {
    id: "agent-1",
    name: "Markup Agent",
    user_id: "owner-1",
    organization_id: "creator-org",
    monetization_enabled: true,
    inference_markup_percentage: "500",
    system: null,
    bio: "Helpful.",
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

async function callChat() {
  return handleToolCall(
    makeContext() as never,
    makeCharacter(),
    {
      name: "chat",
      arguments: { message: "hello", model: "gpt-5-mini" },
    },
    "rpc-1",
    { id: USER_ID, organization_id: ORG_ID },
  );
}

beforeEach(() => {
  languageModel.mockClear();
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

describe("Agent MCP billing", () => {
  test("reserves the marked-up estimate before invoking the model", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });

    const response = await callChat();

    expect(response.status).toBe(200);
    expect(reserve).toHaveBeenCalledTimes(1);
    const reserveParams = reserve.mock.calls[0]?.[0] as { amount: number };
    expect(reserveParams).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      description: "Agent MCP: Markup Agent (gpt-5-mini)",
    });
    expect(reserveParams.amount).toBeCloseTo(0.06, 12);
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      streamText.mock.invocationCallOrder[0],
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBeCloseTo(0.06, 12);
    expect(recordCreatorEarnings).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        earnings: 0.05,
        consumerOrgId: ORG_ID,
        protocol: "mcp",
      }),
    );
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      recordCreatorEarnings.mock.invocationCallOrder[0],
    );
  });

  // #16148: the reserved output ceiling and the provider-facing cap must be one
  // immutable value for every resolved thinking budget — the acceptance table.
  // Previously reserve used `4096 + budget` while the provider got
  // `max(4096, budget) + 4096` (and no cap with thinking off).
  test.each([
    [null, 4096, 0],
    [1024, 5120, 1024],
    [4096, 8192, 4096],
    [8000, 12096, 8000],
  ] as const)("reserves and caps the provider at one ceiling (budget=%p → cap=%p)", async (budget, expectedCap, expectedProviderBudget) => {
    makeReservation({ adjustmentType: "none" });
    resolveAnthropicThinkingBudgetTokens.mockReturnValue(budget);

    const response = await callChat();
    expect(response.status).toBe(200);

    // Reserved with this exact ceiling (3rd arg to estimateRequestCost)...
    expect(estimateRequestCost.mock.calls[0]?.[2]).toBe(expectedCap);
    // ...and the provider is capped at the identical value — always sent.
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(streamText.mock.calls[0]?.[0]?.maxOutputTokens).toBe(expectedCap);
    expect(streamText.mock.calls[0]?.[0]?.maxOutputTokens).toBe(
      estimateRequestCost.mock.calls[0]?.[2],
    );
    // Provider thinking policy uses the already-resolved effective budget
    // (`effectiveThinkingBudget ?? 0`), not a recomputed value.
    expect(mergeAnthropicCotProviderOptions.mock.calls[0]?.[2]).toBe(
      expectedProviderBudget,
    );
  });

  test("does not record creator earnings when final overage is uncollected", async () => {
    makeReservation({ adjustmentType: "uncollected_overage" });
    calculateCost.mockResolvedValue({ totalCost: 0.02 });

    const response = await callChat();
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(200);
    expect(body.error).toEqual({
      code: -32003,
      message: "Insufficient credits for final usage cost",
    });
    expect(recordCreatorEarnings).not.toHaveBeenCalled();
  });

  // Regression for #10266: a post-settlement earnings failure must NOT trigger a
  // second reconcile. The consumer is settled with reconcile(actualTotal); if
  // recordCreatorEarnings throws, the pre-fix code let it reach the outer catch,
  // which ran the NON-idempotent reconcile(0) — double-refunding the WHOLE
  // reservation (free inference + a net credit grant) and returning an error.
  // The fix swallows the earnings error so reconcile fires exactly once and the
  // already-correct settlement response is returned.
  test("post-settlement earnings failure does not double-refund the reservation", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });
    recordCreatorEarnings.mockRejectedValue(
      new Error("transient DB error while recording earnings"),
    );

    const response = await callChat();
    const body = (await response.json()) as {
      result?: { content: Array<{ type: string; text: string }> };
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(200);

    // The reservation is reconciled EXACTLY ONCE, with the real settled total
    // (not the double-refund reconcile(0) from the outer catch).
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBeCloseTo(0.06, 12);

    // The earnings step was attempted (and failed) — but the request still
    // returns the successful settlement, never the -32000 outer-catch error.
    expect(recordCreatorEarnings).toHaveBeenCalledTimes(1);
    expect(body.error).toBeUndefined();
    expect(body.result?.content?.[0]?.text).toBe("hello from model");
  });

  test("get_info returns agent metadata without billing", async () => {
    const response = await handleToolCall(
      makeContext() as never,
      makeCharacter(),
      { name: "get_info", arguments: {} },
      "rpc-1",
      { id: USER_ID, organization_id: ORG_ID },
    );
    const body = (await response.json()) as {
      result?: { content: Array<{ type: string; text: string }> };
    };

    expect(response.status).toBe(200);
    const info = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
    expect(info).toMatchObject({ name: "Markup Agent", monetization: true });
    // Metadata-only: no reservation, no provider call.
    expect(reserve).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("chat with an empty message is rejected before billing", async () => {
    const response = await handleToolCall(
      makeContext() as never,
      makeCharacter(),
      { name: "chat", arguments: { model: "gpt-5-mini" } },
      "rpc-1",
      { id: USER_ID, organization_id: ORG_ID },
    );
    const body = (await response.json()) as { error?: { code: number } };

    expect(body.error?.code).toBe(-32602);
    expect(reserve).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("insufficient credits at reservation returns -32003 and never calls the provider", async () => {
    reserve.mockRejectedValue(new InsufficientCreditsError(0.5, 0.1));

    const response = await callChat();
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(body.error?.code).toBe(-32003);
    expect(body.error?.message).toContain("Insufficient credits");
    // Reserve-before-provider: a failed admission performs no inference.
    expect(streamText).not.toHaveBeenCalled();
  });

  test("a provider error refunds the reservation and returns -32000", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });
    streamText.mockRejectedValue(new Error("provider unavailable"));

    const response = await callChat();
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe("provider unavailable");
    // The whole reservation is refunded (reconcile(0)); no creator earnings.
    expect(reconcile).toHaveBeenCalledWith(0);
    expect(recordCreatorEarnings).not.toHaveBeenCalled();
  });
});
