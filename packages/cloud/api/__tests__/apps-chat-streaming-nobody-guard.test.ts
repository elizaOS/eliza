/**
 * Route-level double-credit guard for POST /api/v1/apps/:id/chat
 * STREAMING no-body refund (sibling of the non-streaming #11218 hardening).
 *
 * When the provider returns no response body, the streaming branch refunds the
 * full hold via `appCreditsService.reconcileCredits`. The route flips
 * `streamCompleted` IMMEDIATELY BEFORE invoking that refund — not after it
 * returns. That ordering is the whole fix: `reconcileCredits` is not
 * transactional; its refund branch commits `creditsService.refundCredits`
 * (app-credits.ts) and can then throw from `reverseCreatorEarnings` / the
 * apps-aggregate update. With the flag still false at that point, the throw
 * reaches the streaming catch as "stream failed before delivery" and
 * `reconcileStreamProcessingError` refunds the FULL hold a SECOND time —
 * double-credit / mint.
 *
 * The helper tests (apps-chat-stream-refund.test.ts) drive
 * `reconcileStreamProcessingError` with a pre-computed boolean, so they stay
 * green even if the route's flag ordering regresses. This suite drives the REAL
 * route with a credits seam that models the real non-transactional internals
 * (refund committed, then throw), asserting the refund COUNT end to end.
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

// Credits seam modeling the REAL app-credits reconcileCredits internals: the
// refund branch commits the org-balance movement (creditsService.refundCredits)
// FIRST, then reverseCreatorEarnings / the apps-aggregate update can throw.
// `refundCommits` counts committed org-balance refunds — the double-credit
// assertion target. The streaming guard's own refund (description "Refund due
// to stream error") never throws, exactly like a plain full refund.
const refundCommits: Array<{ amount: number; description: string }> = [];
const reconcileCalls: Array<{
  estimatedBaseCost: number;
  actualBaseCost: number;
  description: string;
  metadata?: Record<string, unknown>;
}> = [];
let noBodyReverseEarningsThrows = false;

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
      description: args.description,
      metadata: args.metadata,
    });
    if (args.actualBaseCost < args.estimatedBaseCost) {
      // app-credits.ts refund branch: this movement COMMITS before the
      // earnings/counter writes below can throw.
      refundCommits.push({
        amount: args.estimatedBaseCost - args.actualBaseCost,
        description: args.description,
      });
    }
    if (args.metadata?.noBody && noBodyReverseEarningsThrows) {
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
// reconcile runs). Drain the body, then wait for the reconcile to land plus a
// grace window so an erroneous SECOND refund would be observed.
async function drainAndSettle(response: Response): Promise<string> {
  const text = await response.text();
  const deadline = Date.now() + 2000;
  while (reconcileCredits.mock.calls.length === 0 && Date.now() < deadline) {
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
  reconcileCalls.length = 0;
  reconcileCredits.mockClear();
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

    // The no-body refund reconcile ran once, its internal refund committed
    // once, and the streaming catch did NOT issue a second full-hold refund
    // ("Refund due to stream error") on top of it.
    expect(reconcileCredits).toHaveBeenCalledTimes(1);
    expect(refundCommits).toHaveLength(1);
    expect(reconcileCalls[0].metadata).toMatchObject({
      error: true,
      noBody: true,
    });
    expect(
      reconcileCalls.some(
        (c) => c.description === "Refund due to stream error",
      ),
    ).toBe(false);

    // The client got the no-body error event and a closed stream, not a hang.
    expect(text).toContain("empty_response");
    expect(text).toContain("[DONE]");
  });

  test("no-body refund succeeds → refund exactly once and the error event reaches the client", async () => {
    const response = await postChat();
    expect(response.status).toBe(200);
    const text = await drainAndSettle(response);

    expect(reconcileCredits).toHaveBeenCalledTimes(1);
    expect(refundCommits).toHaveLength(1);
    expect(reconcileCalls[0].actualBaseCost).toBe(0);
    expect(reconcileCalls[0].metadata).toMatchObject({
      error: true,
      noBody: true,
    });
    expect(text).toContain("empty_response");
    expect(text).toContain("[DONE]");
  });

  test("stream completes normally → exactly one settle reconcile, no refund guard", async () => {
    providerResponseImpl = sseProviderBody;

    const response = await postChat();
    expect(response.status).toBe(200);
    const text = await drainAndSettle(response);

    expect(text).toContain("hi there");
    expect(reconcileCredits).toHaveBeenCalledTimes(1);
    expect(reconcileCalls[0].metadata).toMatchObject({ streaming: true });
    expect(reconcileCalls[0].metadata?.noBody).toBeUndefined();
    expect(reconcileCalls[0].actualBaseCost).toBe(0.001);
    expect(
      reconcileCalls.some(
        (c) => c.description === "Refund due to stream error",
      ),
    ).toBe(false);
  });
});
