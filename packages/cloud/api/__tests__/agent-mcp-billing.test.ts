/**
 * Agent MCP billing invariants for monetized agents.
 *
 * The route must reserve the marked-up estimate up front and must not credit
 * creator earnings unless final reconciliation confirms the consumer charge was
 * collected.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";
// `mock.module` is process-global: spread the real auth module so this file's
// partial mock (only `requireUserOrApiKeyWithOrg`) does not drop the other auth
// exports (e.g. `requireUserOrApiKey`) for later test files in the same run.
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";

const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const USER_ID = "00000000-0000-4000-8000-0000000000bb";

const getLanguageModel = mock((model: string) => ({ model }));
mock.module("@/lib/providers/language-model", () => ({
  getLanguageModel,
  resolveAiProviderSource: () => "gateway",
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
const markProviderDispatched = mock();
const admitOrganizationInference = mock(
  async (params: {
    context: { organizationId: string; userId: string; description: string };
    flatCost: { totalCost: number };
  }) => {
    const reservation = await reserve({
      organizationId: params.context.organizationId,
      userId: params.context.userId,
      description: params.context.description,
      amount: params.flatCost.totalCost,
    });
    return {
      settle: reservation.reconcile,
      settleUnknown: () => reservation.reconcile(params.flatCost.totalCost),
      markProviderDispatched,
    };
  },
);
const inferenceCredential = {
  kind: "api_key" as const,
  credentialId: "key-1",
  userId: USER_ID,
};
const requireGenerativeRouteCaller = mock(
  async (
    _c?: unknown,
    _options?: { deferStrongCredentialCheck?: boolean },
  ) => ({
    user: { id: USER_ID, organization_id: ORG_ID },
    apiKeyId: null,
    appScopeId: null,
    authSource: "compatibility" as const,
    credential: inferenceCredential,
  }),
);
const charactersGetById = mock();
const assertInferenceCredentialActive = mock(async () => undefined);
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
mock.module("@/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference,
}));

mock.module("@/api-app/lib/generative-route-auth", () => ({
  asGenerativeCacheApiError: (error: unknown) =>
    error instanceof ApiError ? error : null,
  getGenerativeExecutionContext: () => undefined,
  resolveInferenceCredentialAdmissionDenial: () => null,
  requireGenerativeRouteCaller,
}));

mock.module("@/lib/services/inference-credential-revocation", () => ({
  assertInferenceCredentialActive,
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { getById: charactersGetById },
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

const { default: mcpRoute, handleToolCall } = await import(
  "../agents/[id]/mcp/route"
);

const app = new Hono();
app.route("/agents/:id/mcp", mcpRoute);

function textStream(text: string) {
  return (async function* stream() {
    yield text;
  })();
}

function makeContext() {
  return {
    env: {},
    get: () => undefined,
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
    is_public: true,
    mcp_enabled: true,
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
    {
      id: USER_ID,
      organization_id: ORG_ID,
      credentialForAdmission: () => inferenceCredential,
    },
  );
}

function callRouteChat() {
  return app.request(
    "/agents/agent-1/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "chat",
          arguments: { message: "hello", model: "gpt-5-mini" },
        },
        id: "rpc-1",
      }),
    },
    {},
  );
}

beforeEach(() => {
  requireGenerativeRouteCaller.mockReset();
  requireGenerativeRouteCaller.mockResolvedValue({
    user: { id: USER_ID, organization_id: ORG_ID },
    apiKeyId: null,
    appScopeId: null,
    authSource: "compatibility",
    credential: inferenceCredential,
  });
  charactersGetById.mockReset();
  assertInferenceCredentialActive.mockReset();
  assertInferenceCredentialActive.mockResolvedValue(undefined);
  charactersGetById.mockResolvedValue(makeCharacter());
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
  admitOrganizationInference.mockClear();
  markProviderDispatched.mockReset();
  markProviderDispatched.mockResolvedValue(undefined);

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
  test("standing denial precedes character lookup and preserves its safe reason", async () => {
    requireGenerativeRouteCaller.mockRejectedValueOnce(
      new ApiError(403, "access_denied", "Organization is inactive", {
        reason: "organization_inactive",
      }),
    );

    const response = await app.request("/agents/agent-1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{malformed",
    });
    const body = (await response.json()) as {
      jsonrpc?: string;
      error?: { code: number; message: string; data?: { reason?: string } };
      id?: string | number | null;
    };

    expect(response.status).toBe(403);
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32002,
        message: "Organization is inactive",
        data: { reason: "organization_inactive" },
      },
      id: null,
    });
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deferStrongCredentialCheck: true }),
    );
    expect(charactersGetById).not.toHaveBeenCalled();
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("checks the deferred credential once when JSON parsing terminates before any resource or provider work", async () => {
    const response = await app.request("/agents/agent-1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{malformed",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: -32700, message: "Parse error" },
    });
    expect(assertInferenceCredentialActive).toHaveBeenCalledTimes(1);
    expect(assertInferenceCredentialActive).toHaveBeenCalledWith(
      ORG_ID,
      inferenceCredential,
    );
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("reserves the marked-up estimate before invoking the model", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });

    const response = await callRouteChat();

    expect(response.status).toBe(200);
    expect(admitOrganizationInference).toHaveBeenCalledWith(
      expect.objectContaining({ credential: inferenceCredential }),
    );
    expect(assertInferenceCredentialActive).not.toHaveBeenCalled();
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

  // Billing uses a conservative estimate without turning that estimate into a
  // provider cap. The table covers both no-thinking and thinking estimates.
  test.each([
    [null, 4096, 0],
    [1024, 5120, 1024],
    [4096, 8192, 4096],
    [8000, 12096, 8000],
  ] as const)(
    "reserves an estimate without capping provider output (budget=%p → estimate=%p)",
    async (budget, expectedEstimate, expectedProviderBudget) => {
      makeReservation({ adjustmentType: "none" });
      resolveAnthropicThinkingBudgetTokens.mockReturnValue(budget);

      const response = await callChat();
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result?: { _meta?: { admittedOutputTokens?: number } };
      };

      expect(estimateRequestCost.mock.calls[0]?.[2]).toBe(expectedEstimate);
      expect(streamText).toHaveBeenCalledTimes(1);
      expect(streamText.mock.calls[0]?.[0]?.maxOutputTokens).toBeUndefined();
      expect(body.result?._meta?.admittedOutputTokens).toBe(expectedEstimate);
      // Provider thinking policy uses the already-resolved effective budget
      // (`effectiveThinkingBudget ?? 0`), not a recomputed value.
      expect(mergeAnthropicCotProviderOptions.mock.calls[0]?.[2]).toBe(
        expectedProviderBudget,
      );
    },
  );

  test("does not record creator earnings when final overage is uncollected", async () => {
    makeReservation({ adjustmentType: "uncollected_overage" });
    calculateCost.mockResolvedValue({ totalCost: 0.02 });

    const response = await callChat();
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(recordCreatorEarnings).not.toHaveBeenCalled();
  });

  // The consumer settlement is non-idempotent: a later creator-accounting
  // failure must remain visible without entering the outer refund boundary.
  test("post-settlement earnings failure does not double-refund the reservation", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });
    recordCreatorEarnings.mockRejectedValue(
      new Error("transient DB error while recording earnings"),
    );

    const response = await callChat();
    const body = (await response.json()) as {
      result?: {
        content: Array<{ type: string; text: string }>;
        _meta?: { warnings?: Array<{ code: string; message: string }> };
      };
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(200);

    // The reservation is reconciled EXACTLY ONCE, with the real settled total
    // (not the double-refund reconcile(0) from the outer catch).
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBeCloseTo(0.06, 12);

    // Settlement remains successful, while the warning makes the failed
    // secondary accounting write observable to the caller.
    expect(recordCreatorEarnings).toHaveBeenCalledTimes(1);
    expect(body.error).toBeUndefined();
    expect(body.result?.content?.[0]?.text).toBe("hello from model");
    expect(body.result?._meta?.warnings).toBeUndefined();
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

  test.each([
    ["missing tool name", {}],
    ["blank tool name", { name: "" }],
    ["non-object arguments", { name: "chat", arguments: "invalid" }],
  ])("rejects %s before billing", async (_case, params) => {
    const response = await handleToolCall(
      makeContext() as never,
      makeCharacter(),
      params,
      "rpc-1",
      { id: USER_ID, organization_id: ORG_ID },
    );
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: -32602,
      message: "valid tool call params are required",
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test.each([
    ["missing message", { model: "gpt-5-mini" }],
    ["blank message", { message: "   ", model: "gpt-5-mini" }],
    ["non-string message", { message: 42, model: "gpt-5-mini" }],
    ["blank model", { message: "hello", model: "" }],
  ])("chat with %s is rejected before billing", async (_case, args) => {
    const response = await handleToolCall(
      makeContext() as never,
      makeCharacter(),
      { name: "chat", arguments: args },
      "rpc-1",
      { id: USER_ID, organization_id: ORG_ID },
    );
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: -32602,
      message: "valid chat arguments are required",
    });
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

  test("missing provider usage settles the reserved estimate instead of fabricating zero metering", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });
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
    expect(reconcile.mock.calls[0]?.[0]).toBeCloseTo(0.06, 12);
    expect(markProviderDispatched).toHaveBeenCalledTimes(1);
    expect(recordCreatorEarnings).not.toHaveBeenCalled();
  });

  test("a provider rejection settles the reserved estimate and returns -32000", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });
    streamText.mockRejectedValue(new Error("provider unavailable"));

    const response = await callChat();
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe("provider unavailable");
    expect(reconcile.mock.calls[0]?.[0]).toBeCloseTo(0.06, 12);
    expect(markProviderDispatched).toHaveBeenCalledTimes(1);
    expect(recordCreatorEarnings).not.toHaveBeenCalled();
  });

  test("incomplete provider output settles the reserved estimate", async () => {
    const reconcile = makeReservation({ adjustmentType: "none" });
    streamText.mockResolvedValue({
      textStream: textStream("partial output"),
      finishReason: Promise.resolve("length"),
      usage: Promise.resolve({
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
      }),
    });

    const response = await callChat();
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };

    expect(body.error?.code).toBe(-32000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBeCloseTo(0.06, 12);
    expect(recordCreatorEarnings).not.toHaveBeenCalled();
  });

  test("a dispatch-marker failure refunds before provider dispatch", async () => {
    const reconcile = makeReservation({ adjustmentType: "refund" });
    markProviderDispatched.mockRejectedValue(new Error("marker unavailable"));

    const response = await callChat();

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(0);
    expect(streamText).not.toHaveBeenCalled();
    expect(recordCreatorEarnings).not.toHaveBeenCalled();
  });
});
