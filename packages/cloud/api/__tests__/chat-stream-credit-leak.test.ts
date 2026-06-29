/**
 * Money-leak reproduction test for POST /api/v1/chat streaming.
 *
 * The route reserves credits before forwarding to the model provider. AI SDK
 * provider failures during streaming call streamText.onError, not onFinish or
 * onAbort. This drives the real Hono route with mocked auth/provider seams and
 * a real credit-reservation settler, proving onError releases the upfront hold.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

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

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: mock(async () => ({ id: USER, organization_id: ORG })),
}));

mock.module("@/lib/auth-anonymous", () => ({
  checkAnonymousLimit: mock(),
  getAnonymousUser: mock(),
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

mock.module("@/lib/services/credits", () => ({
  creditsService: {
    createAnonymousReservation: mock(
      () => makeLedgerReservation(0, 0).reservation,
    ),
    reserve: mock(async () => ledger.reservation),
  },
  InsufficientCreditsError: TestInsufficientCreditsError,
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
});

describe("/v1/chat streaming credit reservation", () => {
  test("provider onError releases the hold and a later abort cannot double-refund", async () => {
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
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);

    const onAbort = capturedConfig?.onAbort as
      | (() => Promise<unknown>)
      | undefined;
    await onAbort?.();
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });
});
