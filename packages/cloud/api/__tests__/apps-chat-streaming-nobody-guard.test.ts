/**
 * Route-level double-credit guard for POST /api/v1/apps/:id/chat
 * STREAMING no-body refund (sibling of the non-streaming #11218 hardening).
 *
 * When the provider returns no response body, the streaming branch settles the
 * app-credit reservation to actual cost 0. The route flips `streamCompleted`
 * IMMEDIATELY BEFORE invoking that settlement — not after it returns. That
 * ordering is the route-level guard: app-credit settlement can commit the
 * refund movement and then throw from creator-earnings / aggregate writes. With
 * the flag still false at that point, the throw reaches the streaming catch as
 * "stream failed before delivery" and issues a SECOND full-hold refund —
 * double-credit / mint.
 *
 * The helper tests (apps-chat-stream-refund.test.ts) drive
 * `reconcileStreamProcessingError` with a pre-computed boolean, so they stay
 * green even if the route's flag ordering regresses. This suite drives the REAL
 * route with a reservation seam that models the real non-transactional
 * internals (refund committed, then throw), asserting the refund COUNT end to
 * end.
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
// streaming settle call (only reached when the provider body streams to
// completion) returns 0.001 so that reconcile takes the refund-down branch.
let calculateCostCalls = 0;
mock.module("@/lib/pricing", () => ({
  calculateCost: mock(async () => {
    calculateCostCalls += 1;
    if (calculateCostCalls === 1) return { totalCost: 0.01 };
    return { totalCost: 0.001 };
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

// `new Response(null)` has a null body, so the streaming branch's
// `providerResponse.body?.getReader()` yields no reader → the no-body refund
// path under test runs.
let providerResponseImpl: () => Response = () => new Response(null);
mock.module("@/lib/providers", () => ({
  getProviderForModelWithFallback: () => ({
    primary: { chatCompletions: async () => providerResponseImpl() },
    fallback: null,
  }),
  withProviderFallback: async (primary: () => Promise<Response>) => primary(),
}));

class TestInsufficientCreditsError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
    public readonly reason?: string,
  ) {
    super(`Insufficient credits. Required: ${required}, available: ${available}`);
  }
}

mock.module("@/lib/services/credits", () => ({
  InsufficientCreditsError: TestInsufficientCreditsError,
}));

mock.module("@/lib/runtime/request-context", () => ({
  getRequestIdempotencyKey: () => "apps-chat-streaming-nobody-guard",
}));

// Credits seam modeling the REAL app-credits reservation settlement internals:
// the refund branch commits the org-balance movement FIRST, then
// reverseCreatorEarnings / the apps-aggregate update can throw. `refundCommits`
// counts committed org-balance refunds — the double-credit assertion target.
const refundCommits: Array<{ amount: number; description: string }> = [];
const reservationCalls: Array<{
  estimatedBaseCost: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}> = [];
const settleCalls: Array<{
  actualBaseCost: number;
}> = [];
let noBodyReverseEarningsThrows = false;

const reserveInferenceCredits = mock(
  async (args: {
    estimatedBaseCost: number;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }) => {
    reservationCalls.push({
      estimatedBaseCost: args.estimatedBaseCost,
      idempotencyKey: args.idempotencyKey,
      metadata: args.metadata,
    });
    return {
      reservedAmount: args.estimatedBaseCost,
      reservationTransactionId: "reservation-1",
      reconcile: async (actualBaseCost: number) => {
        settleCalls.push({ actualBaseCost });
        if (actualBaseCost < args.estimatedBaseCost) {
          refundCommits.push({
            amount: args.estimatedBaseCost - actualBaseCost,
            description: "reservation reconcile",
          });
        }
        if (actualBaseCost === 0 && noBodyReverseEarningsThrows) {
          throw new Error("reverseCreatorEarnings failed: deadlock detected");
        }
        return {
          reservedAmount: args.estimatedBaseCost,
          actualCost: actualBaseCost,
          reservationTransactionId: "reservation-1",
          settlementTransactionIds: [],
          adjustmentType:
            actualBaseCost < args.estimatedBaseCost ? "refund" : "none",
        };
      },
    };
  },
);

mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {
    reserveInferenceCredits,
  },
}));

const { default: chatRoute } = await import("../v1/apps/[id]/chat/route");

const app = new Hono();
app.route("/api/v1/apps/:id/chat", chatRoute);

async function postChat(): Promise<Response> {
  return await app.request(`/api/v1/apps/${APP_ID}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  });
}

// The route hands the SSE readable back while the money work continues in a
// detached task (and the fixed ordering closes the writer BEFORE the refund
// settlement runs). Drain the body, then wait for the settlement to land plus a
// grace window so an erroneous SECOND refund would be observed.
async function drainAndSettle(response: Response): Promise<string> {
  const text = await response.text();
  const deadline = Date.now() + 2000;
  while (settleCalls.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return text;
}

function sseProviderBody(): Response {
  const payload = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi there" } }] })}`,
    "",
    `data: ${JSON.stringify({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ delta: {} }],
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
  return new Response(payload, {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  refundCommits.length = 0;
  reservationCalls.length = 0;
  settleCalls.length = 0;
  reserveInferenceCredits.mockClear();
  calculateCostCalls = 0;
  noBodyReverseEarningsThrows = false;
  providerResponseImpl = () => new Response(null);
});

describe("streaming no-body refund double-credit guard", () => {
  test("no-body refund reconcile throws AFTER its refund committed → NO second refund (no double-credit)", async () => {
    noBodyReverseEarningsThrows = true;

    const response = await postChat();
    expect(response.status).toBe(200);
    const text = await drainAndSettle(response);

    // The no-body settlement ran once, its internal refund committed once, and
    // the streaming catch did NOT issue a second full-hold refund on top of it.
    expect(reserveInferenceCredits).toHaveBeenCalledTimes(1);
    expect(settleCalls).toHaveLength(1);
    expect(refundCommits).toHaveLength(1);
    expect(settleCalls[0].actualBaseCost).toBe(0);
    expect(reservationCalls[0].idempotencyKey).toBe(
      "apps-chat-streaming-nobody-guard",
    );

    // The client got the no-body error event and a closed stream, not a hang.
    expect(text).toContain("empty_response");
    expect(text).toContain("[DONE]");
  });

  test("no-body refund succeeds → refund exactly once and the error event reaches the client", async () => {
    const response = await postChat();
    expect(response.status).toBe(200);
    const text = await drainAndSettle(response);

    expect(reserveInferenceCredits).toHaveBeenCalledTimes(1);
    expect(settleCalls).toHaveLength(1);
    expect(refundCommits).toHaveLength(1);
    expect(settleCalls[0].actualBaseCost).toBe(0);
    expect(text).toContain("empty_response");
    expect(text).toContain("[DONE]");
  });

  test("stream completes normally → exactly one settle reconcile, no refund guard", async () => {
    providerResponseImpl = sseProviderBody;

    const response = await postChat();
    expect(response.status).toBe(200);
    const text = await drainAndSettle(response);

    expect(text).toContain("hi there");
    expect(reserveInferenceCredits).toHaveBeenCalledTimes(1);
    expect(settleCalls).toHaveLength(1);
    expect(reservationCalls[0].metadata).toMatchObject({ streaming: true });
    expect(settleCalls[0].actualBaseCost).toBe(0.001);
  });
});
