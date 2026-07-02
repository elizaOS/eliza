/**
 * Route-level double-credit guard for POST /api/v1/apps/:id/chat
 * non-streaming settle (#11218 hardening).
 *
 * The route flips `nonStreamingSettleStarted` IMMEDIATELY BEFORE invoking
 * `appCreditsService.reconcileCredits` — not after it returns. That ordering is
 * the whole fix: `reconcileCredits` is not transactional; its refund branch
 * commits `creditsService.refundCredits` (app-credits.ts) and can then throw
 * from `reverseCreatorEarnings` / the apps-aggregate update. With the flag set
 * only after return, that throw reaches the settle catch as "never settled" and
 * the guard refunds the FULL hold a second time — double-credit.
 *
 * The helper tests (apps-chat-stream-refund.test.ts) drive the shared
 * `reconcileChatSettleError` with a pre-computed boolean, so they stay green
 * even if the route's flag ordering regresses. This suite drives the REAL
 * route with a credits seam that models the real non-transactional internals
 * (refund committed, then throw), asserting the refund COUNT end to end —
 * plus the streaming branch, so BOTH route call sites are proven to reach the
 * one shared helper with their own skipRefund flag and ledger tags.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const APP_ID = "00000000-0000-4000-8000-0000000000ee";

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: mock(async () => ({
    user: { id: USER, organization_id: ORG },
    apiKey: undefined,
  })),
}));

mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: mock(async () => false),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/apps", () => ({
  appsService: {
    getById: mock(async () => ({
      id: APP_ID,
      name: "guard-test-app",
      organization_id: ORG,
      monetization_enabled: true,
      platform_offset_amount: 0,
      purchase_share_percentage: 0,
      inference_markup_percentage: 20,
    })),
  },
}));

// Estimate call returns 0.01 (reserved = 0.015 after the 1.5x buffer); the
// settle call returns 0.001 so the settle reconcile takes the REFUND branch
// (actual < reserved), matching the dominant production case the 1.5x safety
// multiplier produces. A test can swap `settleCostImpl` to make the
// settle-side cost calc throw.
let calculateCostCalls = 0;
let settleCostImpl: () => Promise<{ totalCost: number }> = async () => ({
  totalCost: 0.001,
});
mock.module("@/lib/pricing", () => ({
  calculateCost: mock(async () => {
    calculateCostCalls += 1;
    if (calculateCostCalls === 1) return { totalCost: 0.01 };
    return settleCostImpl();
  }),
  estimateTokens: (text: string) => Math.max(1, Math.ceil(text.length / 4)),
  getProviderFromModel: () => "openai",
  normalizeModelName: (model: string) => model,
}));

mock.module("@/lib/providers/language-model", () => ({
  canonicalizeCerebrasModelId: (model: string) => model,
  getAiProviderConfigurationError: () => "AI services are not configured",
  hasLanguageModelProviderConfigured: () => true,
  resolveAiProviderSource: () => "openai",
}));

let providerResponseImpl: () => Response = () =>
  new Response("{}", { headers: { "content-type": "application/json" } });
mock.module("@/lib/providers", () => ({
  getProviderForModelWithFallback: () => ({
    primary: { chatCompletions: async () => providerResponseImpl() },
    fallback: null,
  }),
  withProviderFallback: async (primary: () => Promise<Response>) => primary(),
}));

// Credits seam modeling the REAL app-credits reconcileCredits internals: the
// refund branch commits the org-balance movement (creditsService.refundCredits)
// FIRST, then reverseCreatorEarnings / the apps-aggregate update can throw.
// `refundCommits` counts committed org-balance refunds — the double-credit
// assertion target. The guard's own refund call (tagged refundReason
// non_streaming_settle_error) never throws, exactly like a plain full refund.
const refundCommits: Array<{ amount: number; description: string }> = [];
const reconcileCalls: Array<{
  estimatedBaseCost: number;
  actualBaseCost: number;
  metadata?: Record<string, unknown>;
}> = [];
let settleReverseEarningsThrows = false;

const reconcileCredits = mock(
  async (args: {
    estimatedBaseCost: number;
    actualBaseCost: number;
    description: string;
    metadata?: Record<string, unknown>;
  }) => {
    reconcileCalls.push({
      estimatedBaseCost: args.estimatedBaseCost,
      actualBaseCost: args.actualBaseCost,
      metadata: args.metadata,
    });
    const isGuardRefund =
      args.metadata?.refundReason === "non_streaming_settle_error";
    if (args.actualBaseCost < args.estimatedBaseCost) {
      // app-credits.ts refund branch: this movement COMMITS before the
      // earnings/counter writes below can throw.
      refundCommits.push({
        amount: args.estimatedBaseCost - args.actualBaseCost,
        description: args.description,
      });
    }
    if (!isGuardRefund && settleReverseEarningsThrows) {
      throw new Error("reverseCreatorEarnings failed: deadlock detected");
    }
    return {
      reconciled: true,
      difference: args.actualBaseCost - args.estimatedBaseCost,
      action: "refund",
      adjustedAmount: args.estimatedBaseCost - args.actualBaseCost,
      newBalance: 99,
    };
  },
);

mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {
    deductCredits: mock(async (args: { baseCost: number }) => ({
      success: true,
      baseCost: args.baseCost,
      creatorMarkup: 0,
      totalCost: args.baseCost,
      creatorEarnings: 0,
      newBalance: 99,
    })),
    reconcileCredits,
  },
}));

const { default: chatRoute } = await import("../v1/apps/[id]/chat/route");

const app = new Hono();
app.route("/api/v1/apps/:id/chat", chatRoute);

async function postChat(stream = false): Promise<Response> {
  return await app.request(`/api/v1/apps/${APP_ID}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: "hello" }],
      stream,
    }),
  });
}

function okProviderBody(): Response {
  return new Response(
    JSON.stringify({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { content: "hi there" } }],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  refundCommits.length = 0;
  reconcileCalls.length = 0;
  reconcileCredits.mockClear();
  calculateCostCalls = 0;
  settleCostImpl = async () => ({ totalCost: 0.001 });
  settleReverseEarningsThrows = false;
  providerResponseImpl = okProviderBody;
});

describe("non-streaming settle double-credit guard (#11218)", () => {
  test("settle reconcile throws AFTER its refund committed → NO second refund (no double-credit)", async () => {
    settleReverseEarningsThrows = true;

    const response = await postChat();

    // The settle reconcile ran once, its internal refund committed once, and
    // the guard did NOT issue a second full-hold refund on top of it.
    expect(reconcileCredits).toHaveBeenCalledTimes(1);
    expect(refundCommits).toHaveLength(1);
    expect(
      reconcileCalls.some(
        (c) => c.metadata?.refundReason === "non_streaming_settle_error",
      ),
    ).toBe(false);

    // The original settle error surfaces unmasked.
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "reverseCreatorEarnings failed: deadlock detected",
    );
  });

  test("malformed provider body (throw BEFORE the reconcile) → auto-refund exactly once", async () => {
    providerResponseImpl = () => new Response("definitely not json");

    const response = await postChat();

    // Guard refunds the full hold exactly once, tagged for the ledger.
    expect(reconcileCredits).toHaveBeenCalledTimes(1);
    expect(refundCommits).toHaveLength(1);
    expect(reconcileCalls[0].actualBaseCost).toBe(0);
    expect(reconcileCalls[0].metadata).toMatchObject({
      streaming: false,
      refundReason: "non_streaming_settle_error",
    });
    expect(response.status).toBe(500);
  });

  test("calculateCost throws (throw BEFORE the reconcile) → auto-refund exactly once", async () => {
    settleCostImpl = async () => {
      throw new Error("pricing catalog unavailable");
    };

    const response = await postChat();

    expect(reconcileCredits).toHaveBeenCalledTimes(1);
    expect(refundCommits).toHaveLength(1);
    expect(reconcileCalls[0].actualBaseCost).toBe(0);
    expect(reconcileCalls[0].metadata).toMatchObject({
      refundReason: "non_streaming_settle_error",
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("pricing catalog unavailable");
  });

  test("settle succeeds → 200 with the provider body and exactly one reconcile", async () => {
    const response = await postChat();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0].message.content).toBe("hi there");
    expect(reconcileCredits).toHaveBeenCalledTimes(1);
    expect(
      reconcileCalls.some(
        (c) => c.metadata?.refundReason === "non_streaming_settle_error",
      ),
    ).toBe(false);
  });
});

// SSE provider body helpers for the streaming branch.
function sseResponse(build: (c: ReadableStreamDefaultController) => void) {
  return new Response(
    new ReadableStream({
      start(controller) {
        build(controller);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const encoder = new TextEncoder();

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("streaming settle-error refund routes through the same shared helper (#10837)", () => {
  test("stream fails MID-DELIVERY → exactly one full refund, tagged streaming:true", async () => {
    providerResponseImpl = () =>
      sseResponse((controller) => {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
        );
        controller.error(new Error("provider stream reset"));
      });

    const response = await postChat(true);
    expect(response.status).toBe(200);
    // Body EOF = the background catch ran to completion (it closes the writer
    // after the refund).
    const body = await response.text();
    expect(body).toContain("Stream interrupted. Credits refunded.");

    expect(reconcileCredits).toHaveBeenCalledTimes(1);
    expect(refundCommits).toHaveLength(1);
    expect(reconcileCalls[0].actualBaseCost).toBe(0);
    expect(reconcileCalls[0].metadata).toMatchObject({
      error: true,
      streaming: true,
    });
  });

  test("stream COMPLETED then accounting threw → NO refund (skipRefund keeps the charge)", async () => {
    providerResponseImpl = () =>
      sseResponse((controller) => {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      });
    // Post-delivery accounting (the 2nd calculateCost call) throws.
    settleCostImpl = async () => {
      throw new Error("pricing catalog unavailable");
    };

    const response = await postChat(true);
    expect(response.status).toBe(200);
    await response.text();

    // The writer closes BEFORE the accounting runs — wait for the background
    // accounting to reach calculateCost and its catch to settle.
    await waitFor(() => calculateCostCalls === 2);
    await new Promise((r) => setTimeout(r, 25));

    expect(reconcileCredits).not.toHaveBeenCalled();
    expect(refundCommits).toHaveLength(0);
  });
});
