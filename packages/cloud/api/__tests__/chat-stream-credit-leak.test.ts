/**
 * Money-leak reproduction test for POST /api/v1/chat streaming.
 *
 * The route reserves credits before forwarding to the model provider. AI SDK
 * provider failures during streaming call streamText.onError, not onFinish or
 * onAbort. This drives the real Hono route with mocked auth/provider seams and
 * a ledger-backed settler, proving explicit rejections release the hold while
 * ambiguous provider outcomes retain it.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { APICallError } from "ai";

const aiActual = require("ai") as Record<string, unknown>;
const languageModelActual = await import("@/lib/providers/language-model");

const ORG = "00000000-0000-4000-8000-0000000000cc";
const USER = "00000000-0000-4000-8000-0000000000dd";

let streamTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const streamText = mock((config: Record<string, unknown>) => {
  if (!streamTextImpl) throw new Error("streamTextImpl not set");
  return streamTextImpl(config);
});

mock.module("ai", () => ({
  ...aiActual,
  convertToModelMessages: mock(async (messages: unknown) => messages),
  streamText,
}));

// Controllable auth seam so tests can drive authed / authed-org-less / anonymous.
let currentUserImpl: () => Promise<{
  id: string;
  organization_id?: string | null;
} | null> = async () => ({ id: USER, organization_id: ORG });
mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: mock(() => currentUserImpl()),
}));

let anonymousUserImpl: (() => Promise<unknown>) | null = null;
mock.module("@/lib/auth-anonymous", () => ({
  checkAnonymousLimit: mock(),
  getAnonymousUser: mock(() =>
    anonymousUserImpl ? anonymousUserImpl() : null,
  ),
  reserveAnonymousMessageSlot: mock(async () => ({
    allowed: true,
    remaining: 5,
    limit: 10,
  })),
}));

mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: {
    addTokenUsage: mock(async () => undefined),
    refundMessageSlot: mock(async () => undefined),
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/models", () => ({
  resolveModel: () => ({ modelId: "openai/gpt-oss-120b", provider: "openai" }),
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getAiProviderConfigurationError: () => "AI services are not configured",
  getLanguageModel: () => ({}) as never,
  hasLanguageModelProviderConfigured: () => true,
}));

mock.module("@/lib/services/content-moderation", () => ({
  contentModerationService: {
    moderateInBackground: mock(),
    shouldBlockUser: mock(async () => false),
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

class TestInsufficientCreditsError extends Error {}

function makeLedgerReservation(startBalance: number, hold: number) {
  let balance = startBalance - hold;
  let reconcileCalls = 0;
  return {
    startBalance,
    hold,
    get balance() {
      return balance;
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    reservation: {
      reservedAmount: hold,
      reconcile: async (actualCost: number) => {
        reconcileCalls++;
        balance += hold - actualCost;
        return null;
      },
    },
  };
}

let ledger = makeLedgerReservation(100, 0.015);
const admissionCalls: Array<Record<string, unknown>> = [];

mock.module("@/lib/services/credits", () => ({
  assertCreditRefundWithinReservation: () => {
    throw new Error("credit refund assertion is outside this test path");
  },
  assertValidCreditSettlementCosts: () => {
    throw new Error("credit settlement assertion is outside this test path");
  },
  creditsService: {
    createAnonymousReservation: mock(
      () => makeLedgerReservation(0, 0).reservation,
    ),
  },
  DEFAULT_OUTPUT_TOKENS: 500,
  InsufficientCreditsError: TestInsufficientCreditsError,
  ReservationNotFoundError: class extends Error {},
}));

mock.module("@/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference: mock(async (params: Record<string, unknown>) => {
    admissionCalls.push(params);
    let settlement: Promise<unknown> | undefined;
    const settle = (actualCost: number) => {
      settlement ??= ledger.reservation.reconcile(actualCost);
      return settlement;
    };
    return {
      mode: "synchronous_reservation",
      settle,
      settleUnknown: () => settle(ledger.reservation.reservedAmount),
      reservation: {
        ...ledger.reservation,
        reconcile: settle,
      },
    };
  }),
}));

// #11169 part 2: control the CoT thinking budget so a test can assert the
// reservation is sized for the real output ceiling, not the 500 default.
let cotBudgetImpl: number | null = null;
mock.module("@/lib/providers/anthropic-thinking", () => ({
  resolveAnthropicThinkingBudgetTokens: () => cotBudgetImpl,
  mergeAnthropicCotProviderOptions: () => ({}),
}));

const { default: chatRoute } = await import("../v1/chat/route");

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
});

beforeEach(() => {
  ledger = makeLedgerReservation(100, 0.015);
  streamText.mockClear();
  streamTextImpl = null;
  currentUserImpl = async () => ({ id: USER, organization_id: ORG });
  anonymousUserImpl = null;
});

describe("/v1/chat streaming credit reservation", () => {
  test("ambiguous provider onError keeps the hold and a later abort cannot override it", async () => {
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - ledger.hold, 10);

    let onErrorPromise: Promise<unknown> | undefined;
    let capturedConfig: Record<string, unknown> | undefined;
    streamTextImpl = (config) => {
      capturedConfig = config;
      const onError = config.onError as
        | ((event: { error: unknown }) => Promise<unknown>)
        | undefined;
      onErrorPromise = Promise.resolve(
        onError?.({ error: new Error("provider returned 503") }),
      );
      return {
        toUIMessageStreamResponse: () => new Response("stream-started"),
      };
    };

    const response = await chatRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    await onErrorPromise;

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - ledger.hold, 10);

    const onAbort = capturedConfig?.onAbort as
      | (() => Promise<unknown>)
      | undefined;
    await onAbort?.();
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - ledger.hold, 10);
  });

  test("explicit provider 429 releases the hold", async () => {
    let onErrorPromise: Promise<unknown> | undefined;
    streamTextImpl = (config) => {
      const onError = config.onError as
        | ((event: { error: unknown }) => Promise<unknown>)
        | undefined;
      onErrorPromise = Promise.resolve(
        onError?.({
          error: new APICallError({
            message: "provider returned 429",
            url: "https://provider.example/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 429,
          }),
        }),
      );
      return {
        toUIMessageStreamResponse: () => new Response("stream-started"),
      };
    };

    const response = await chatRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    await onErrorPromise;
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });
});

describe("/v1/chat reservation output-ceiling sizing (#11169 part 2)", () => {
  test("CoT model reserves for the effective output ceiling, not the 500 default", async () => {
    admissionCalls.length = 0;
    cotBudgetImpl = 8000; // → effectiveMax = max(4096, 8000 + 4096) = 12096
    try {
      streamTextImpl = () => ({
        toUIMessageStreamResponse: () => new Response("ok"),
      });
      const res = await chatRoute.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      expect(admissionCalls).toHaveLength(1);
      expect(admissionCalls[0]?.estimatedOutputTokens).toBe(12096);
    } finally {
      cotBudgetImpl = null;
    }
  });

  test("non-CoT model admits against the 500-token default", async () => {
    admissionCalls.length = 0;
    cotBudgetImpl = null;
    streamTextImpl = () => ({
      toUIMessageStreamResponse: () => new Response("ok"),
    });
    const res = await chatRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(admissionCalls).toHaveLength(1);
    expect(admissionCalls[0]?.estimatedOutputTokens).toBe(500);
  });
});

describe("/v1/chat org-membership parity (#10557 part 2)", () => {
  test("authenticated caller with NO organization is rejected 403, never reaches the model", async () => {
    // The defense-in-depth gap: a null-org authenticated user would previously
    // fall through to the anonymous no-op reservation and get unbounded free
    // inference, exempt from the anon cap. Now mirror the sibling routes' org
    // guard and 403 before any provider call.
    currentUserImpl = async () => ({ id: USER, organization_id: null });
    streamTextImpl = () => {
      throw new Error("must not reach the model for an org-less authed user");
    };

    const response = await chatRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    expect(response.status).toBe(403);
    expect(streamText).not.toHaveBeenCalled();
    // No reservation was settled — the caller was rejected before any hold.
    expect(ledger.reconcileCalls).toBe(0);
  });

  test("authenticated caller WITH an organization still streams normally (no regression)", async () => {
    currentUserImpl = async () => ({ id: USER, organization_id: ORG });
    streamTextImpl = () => ({
      toUIMessageStreamResponse: () => new Response("stream-started"),
    });

    const response = await chatRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    expect(response.status).toBe(200);
    expect(streamText).toHaveBeenCalledTimes(1);
  });

  test("genuine anonymous caller is NOT rejected by the org guard (free tier preserved)", async () => {
    // No authed user → anonymous path. The org guard must not touch this caller;
    // anonymous inference still works via the anonymous reservation.
    currentUserImpl = async () => null;
    anonymousUserImpl = async () => ({
      user: { id: "anon-user", organization_id: undefined },
      session: {
        id: "anon-session",
        session_token: "anon-token",
        message_count: 0,
      },
    });
    streamTextImpl = () => ({
      toUIMessageStreamResponse: () => new Response("stream-started"),
    });

    const response = await chatRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    expect(response.status).toBe(200);
    expect(streamText).toHaveBeenCalledTimes(1);
  });
});
