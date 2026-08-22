/**
 * Drives the Worker `/v1/chat` route through cached auth and admission while
 * database-backed compatibility seams are armed to fail if touched.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const aiActual = require("ai") as Record<string, unknown>;
const languageModelActual = await import("@/lib/providers/language-model");

const ORG = "00000000-0000-4000-8000-0000000000cc";
const USER = "00000000-0000-4000-8000-0000000000dd";
const RESERVATION = {
  reservedAmount: 0.02,
  reservationTransactionId: "reservation-a",
  reconcile: mock(async () => undefined),
};

let capturedStreamConfig: Record<string, unknown> | undefined;
const callOrder: string[] = [];
const streamText = mock((config: Record<string, unknown>) => {
  callOrder.push("provider");
  capturedStreamConfig = config;
  return {
    toUIMessageStreamResponse: () => new Response("stream-started"),
  };
});

mock.module("ai", () => ({
  ...aiActual,
  convertToModelMessages: mock(async (messages: unknown) => messages),
  streamText,
}));

const getCurrentUser = mock(async (): Promise<unknown> => {
  throw new Error("database auth must not run on the Worker hot path");
});
mock.module("@/lib/auth/workers-hono-auth", () => ({ getCurrentUser }));

const getAnonymousUser = mock(async (): Promise<unknown> => {
  throw new Error("anonymous database auth must not run for an org caller");
});
const reserveAnonymousMessageSlot = mock(async (): Promise<unknown> => {
  throw new Error("anonymous database quota must not run for an org caller");
});
mock.module("@/lib/auth-anonymous", () => ({
  getAnonymousUser,
  reserveAnonymousMessageSlot,
}));

let anonymousResolutionImpl: () => Promise<unknown> = async () => {
  throw new Error("anonymous gate must not run for an org caller");
};
const resolveAnonymousChatContext = mock(() => anonymousResolutionImpl());
const reserveAnonymousChatSlot = mock(
  async (): Promise<unknown> => ({
    kind: "admitted" as const,
    lease: {
      credential: {
        sessionToken: "anonymous-token",
        context: {
          sessionId: "anonymous-session",
          userId: "anonymous-user",
          messageCount: 0,
          messagesLimit: 10,
        },
      },
      requestId: "anonymous-request",
    },
    remaining: 9,
    limit: 10,
  }),
);
const refundAnonymousChatSlot = mock(async () => undefined);
const commitAnonymousChatSlot = mock(async () => undefined);
const markAnonymousChatSlotDispatched = mock(async () => {
  callOrder.push("anonymous-dispatch");
});
const refreshAnonymousChatModeration = mock(async () => undefined);
mock.module("@/lib/services/anonymous-chat-admission", () => ({
  resolveAnonymousChatContext,
  reserveAnonymousChatSlot,
  refundAnonymousChatSlot,
  commitAnonymousChatSlot,
  markAnonymousChatSlotDispatched,
  refreshAnonymousChatModeration,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

class TestOrgRateLimitCacheNotReadyError extends Error {}
let orgRateLimitResult: Response | null = null;
let orgRateLimitError: Error | null = null;
const enforceOrgRateLimit = mock(async () => {
  callOrder.push("rate-limit");
  if (orgRateLimitError) throw orgRateLimitError;
  return orgRateLimitResult;
});
mock.module("@/lib/middleware/rate-limit", () => ({
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError: TestOrgRateLimitCacheNotReadyError,
}));

mock.module("@/lib/models", () => ({
  resolveModel: () => ({ modelId: "openai/gpt-oss-120b", provider: "openai" }),
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getAiProviderConfigurationError: () => "AI services are not configured",
  getLanguageModel: () => ({}) as never,
  hasLanguageModelProviderConfigured: () => true,
  resolveAiProviderSource: () => "openai",
}));

const shouldBlockUser = mock(async (): Promise<boolean> => {
  throw new Error("database moderation must not run after cached auth");
});
mock.module("@/lib/services/content-moderation", () => ({
  contentModerationService: {
    moderateInBackground: mock(async () => undefined),
    shouldBlockUser,
  },
}));

let authResolutionImpl: () => Promise<unknown> = async () => ({
  kind: "authorized" as const,
  ctx: {
    userId: USER,
    orgId: ORG,
    apiKeyId: "api-key-a",
  },
});
const resolveInferenceAuthContext = mock(() => authResolutionImpl());
mock.module("@/lib/services/inference-auth-context", () => ({
  resolveInferenceAuthContext,
}));

const settle = mock(async () => null);
const settleUnknown = mock(async () => null);
const admitOrganizationInference = mock(
  async (_params: Record<string, unknown>) => {
    callOrder.push("admission");
    return {
      mode: "deferred_reservation",
      settle,
      settleUnknown,
      reservation: RESERVATION,
    };
  },
);
mock.module("@/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference,
}));

let releaseBilling: (() => void) | undefined;
const billUsage = mock(
  async (
    _context: Record<string, unknown>,
    _usage: Record<string, unknown>,
    _reservation: unknown,
  ) => {
    await new Promise<void>((resolve) => {
      releaseBilling = resolve;
    });
    return {
      inputCost: 0.001,
      outputCost: 0.002,
      totalCost: 0.003,
    };
  },
);
mock.module("@/lib/services/ai-billing", () => ({ billUsage }));

mock.module("@/lib/services/credits", () => ({
  creditsService: {
    createAnonymousReservation: mock(() => ({
      reservedAmount: 0,
      reconcile: async () => undefined,
    })),
  },
  DEFAULT_OUTPUT_TOKENS: 500,
  InsufficientCreditsError: class extends Error {},
  ReservationNotFoundError: class extends Error {},
}));

mock.module("@/lib/services/usage", () => ({
  usageService: { create: mock(async () => ({ id: "usage-a" })) },
}));
mock.module("@/lib/services/generations", () => ({
  generationsService: { create: mock(async () => undefined) },
}));
mock.module("@/lib/services/conversations", () => ({
  conversationsService: {
    addMessageWithSequence: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: {
    addTokenUsage: mock(async () => undefined),
    refundMessageSlot: mock(async () => undefined),
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock() },
}));

mock.module("@/lib/providers/anthropic-thinking", () => ({
  resolveAnthropicThinkingBudgetTokens: () => null,
  mergeAnthropicCotProviderOptions: () => ({}),
}));

const { default: chatRoute } = await import("../v1/chat/route");

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
});

beforeEach(() => {
  capturedStreamConfig = undefined;
  releaseBilling = undefined;
  callOrder.length = 0;
  streamText.mockClear();
  billUsage.mockClear();
  settle.mockClear();
  settleUnknown.mockClear();
  admitOrganizationInference.mockClear();
  getCurrentUser.mockClear();
  getAnonymousUser.mockClear();
  reserveAnonymousMessageSlot.mockClear();
  shouldBlockUser.mockClear();
  resolveInferenceAuthContext.mockClear();
  resolveAnonymousChatContext.mockClear();
  reserveAnonymousChatSlot.mockClear();
  refundAnonymousChatSlot.mockClear();
  commitAnonymousChatSlot.mockClear();
  markAnonymousChatSlotDispatched.mockClear();
  enforceOrgRateLimit.mockClear();
  orgRateLimitResult = null;
  orgRateLimitError = null;
  authResolutionImpl = async () => ({
    kind: "authorized" as const,
    ctx: {
      userId: USER,
      orgId: ORG,
      apiKeyId: "api-key-a",
    },
  });
  anonymousResolutionImpl = async () => {
    throw new Error("anonymous gate must not run for an org caller");
  };
});

describe("/v1/chat Worker cache hot path", () => {
  test("enabled Worker admission rejects a missing execution context without database fallback", async () => {
    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer eliza_cached",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      { INFERENCE_DEFERRED_ADMISSION: "true" } as never,
    );

    expect(response.status).toBe(503);
    expect(resolveInferenceAuthContext).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(getAnonymousUser).not.toHaveBeenCalled();
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("dispatches only after cached admission and defers reservation-aware billing", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilTasks.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer eliza_cached",
          "X-Affiliate-Code": "affiliate-a",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {} as never,
      executionCtx,
    );

    expect(response.status).toBe(200);
    expect(callOrder).toEqual(["rate-limit", "admission", "provider"]);
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(getAnonymousUser).not.toHaveBeenCalled();
    expect(reserveAnonymousMessageSlot).not.toHaveBeenCalled();
    expect(shouldBlockUser).not.toHaveBeenCalled();
    expect(resolveInferenceAuthContext).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ cacheOnly: true, executionCtx }),
    );
    expect(enforceOrgRateLimit).toHaveBeenCalledWith(ORG, "completions", {
      cacheOnly: true,
      executionCtx,
    });
    expect(admitOrganizationInference).toHaveBeenCalledWith(
      expect.objectContaining({
        affiliateCode: "affiliate-a",
        executionCtx,
        estimatedOutputTokens: 500,
      }),
    );

    const onFinish = capturedStreamConfig?.onFinish as
      | ((result: {
          text: string;
          usage: { inputTokens: number; outputTokens: number };
        }) => Promise<void>)
      | undefined;
    await onFinish?.({
      text: "hello back",
      usage: { inputTokens: 3, outputTokens: 4 },
    });

    expect(waitUntilTasks).toHaveLength(2);
    expect(settle).not.toHaveBeenCalled();
    releaseBilling?.();
    await Promise.all(waitUntilTasks);
    expect(billUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        affiliateCode: "affiliate-a",
      }),
      { inputTokens: 3, outputTokens: 4 },
      RESERVATION,
    );
    expect(settle).toHaveBeenCalledWith(0.003);
  });

  test("uses the anonymous Durable Object lease without database auth or quota reads", async () => {
    authResolutionImpl = async () => ({ kind: "slow_path" as const });
    anonymousResolutionImpl = async () => ({
      kind: "ready" as const,
      blocked: false,
      credential: {
        sessionToken: "anonymous-token",
        context: {
          sessionId: "anonymous-session",
          userId: "anonymous-user",
          messageCount: 0,
          messagesLimit: 10,
        },
      },
    });
    const waitUntilTasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilTasks.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "eliza-anon-session=anonymous-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {} as never,
      executionCtx,
    );

    expect(response.status).toBe(200);
    expect(resolveAnonymousChatContext).toHaveBeenCalled();
    expect(reserveAnonymousChatSlot).toHaveBeenCalled();
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(getAnonymousUser).not.toHaveBeenCalled();
    expect(reserveAnonymousMessageSlot).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["anonymous-dispatch", "provider"]);
    expect(markAnonymousChatSlotDispatched).toHaveBeenCalledTimes(1);
    expect(waitUntilTasks).toHaveLength(1);

    const onAbort = capturedStreamConfig?.onAbort as
      | (() => Promise<void>)
      | undefined;
    await onAbort?.();
    await Promise.all(waitUntilTasks);
    expect(commitAnonymousChatSlot).toHaveBeenCalledTimes(1);
    expect(refundAnonymousChatSlot).not.toHaveBeenCalled();
  });

  test("fails closed before provider dispatch when anonymous dispatch marking fails", async () => {
    authResolutionImpl = async () => ({ kind: "slow_path" as const });
    anonymousResolutionImpl = async () => ({
      kind: "ready" as const,
      blocked: false,
      credential: {
        sessionToken: "anonymous-token",
        context: {
          sessionId: "anonymous-session",
          userId: "anonymous-user",
          messageCount: 0,
          messagesLimit: 10,
        },
      },
    });
    markAnonymousChatSlotDispatched.mockRejectedValueOnce(
      new Error("dispatch gate stalled"),
    );
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "eliza-anon-session=anonymous-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {} as never,
      executionCtx,
    );
    await Promise.all(background);

    expect(response.status).toBe(500);
    expect(markAnonymousChatSlotDispatched).toHaveBeenCalledTimes(1);
    expect(streamText).not.toHaveBeenCalled();
    expect(refundAnonymousChatSlot).toHaveBeenCalledTimes(1);
    expect(commitAnonymousChatSlot).not.toHaveBeenCalled();
  });

  test("returns the Durable Object hourly Retry-After before provider dispatch", async () => {
    authResolutionImpl = async () => ({ kind: "slow_path" as const });
    anonymousResolutionImpl = async () => ({
      kind: "ready" as const,
      blocked: false,
      credential: {
        sessionToken: "anonymous-token",
        context: {
          sessionId: "anonymous-session",
          userId: "anonymous-user",
          messageCount: 0,
          messagesLimit: 10,
        },
      },
    });
    reserveAnonymousChatSlot.mockResolvedValueOnce({
      kind: "limited",
      reason: "hourly_limit",
      remaining: 0,
      limit: 10,
      retryAfter: 23,
    });
    const executionCtx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "eliza-anon-session=anonymous-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {} as never,
      executionCtx,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("23");
    await expect(response.json()).resolves.toMatchObject({
      reason: "hourly_limit",
      remaining: 0,
      limit: 10,
    });
    expect(streamText).not.toHaveBeenCalled();
    expect(markAnonymousChatSlotDispatched).not.toHaveBeenCalled();
    expect(reserveAnonymousMessageSlot).not.toHaveBeenCalled();
  });

  test("returns the database fallback hourly Retry-After before provider dispatch", async () => {
    getCurrentUser.mockResolvedValueOnce(null);
    getAnonymousUser.mockResolvedValueOnce({
      user: { id: "anonymous-user", organization_id: null },
      session: {
        id: "anonymous-session",
        session_token: "anonymous-token",
        message_count: 0,
        messages_limit: 10,
      },
    });
    shouldBlockUser.mockResolvedValueOnce(false);
    reserveAnonymousMessageSlot.mockResolvedValueOnce({
      allowed: false,
      reason: "hourly_limit",
      remaining: 0,
      limit: 10,
      retryAfter: 31,
    });

    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "eliza-anon-session=anonymous-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {} as never,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("31");
    await expect(response.json()).resolves.toMatchObject({
      reason: "hourly_limit",
      remaining: 0,
      limit: 10,
    });
    expect(reserveAnonymousMessageSlot).toHaveBeenCalledWith("anonymous-token");
    expect(streamText).not.toHaveBeenCalled();
    expect(markAnonymousChatSlotDispatched).not.toHaveBeenCalled();
    expect(reserveAnonymousChatSlot).not.toHaveBeenCalled();
  });

  test("keeps the non-resetting message limit free of Retry-After", async () => {
    authResolutionImpl = async () => ({ kind: "slow_path" as const });
    anonymousResolutionImpl = async () => ({
      kind: "ready" as const,
      blocked: false,
      credential: {
        sessionToken: "anonymous-token",
        context: {
          sessionId: "anonymous-session",
          userId: "anonymous-user",
          messageCount: 10,
          messagesLimit: 10,
        },
      },
    });
    reserveAnonymousChatSlot.mockResolvedValueOnce({
      kind: "limited",
      reason: "message_limit",
      remaining: 0,
      limit: 10,
    });
    const executionCtx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "eliza-anon-session=anonymous-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {} as never,
      executionCtx,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      reason: "message_limit",
      remaining: 0,
      limit: 10,
    });
    expect(streamText).not.toHaveBeenCalled();
    expect(markAnonymousChatSlotDispatched).not.toHaveBeenCalled();
  });

  test("settles the admission when the UI-message stream tears down without callbacks", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilTasks.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    // The SDK's UI-message encoding path dies mid-stream WITHOUT firing
    // onFinish/onAbort/onError — the gap the route's body-wrap backstop closes.
    streamText.mockImplementationOnce((config: Record<string, unknown>) => {
      callOrder.push("provider");
      capturedStreamConfig = config;
      const encoder = new TextEncoder();
      return {
        toUIMessageStreamResponse: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode('data: {"type":"start"}\n\n'),
                );
              },
              pull() {
                throw new Error("UI-message stream encoding failed");
              },
            }),
          ),
      };
    });

    const response = await chatRoute.fetch(
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer eliza_cached",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {} as never,
      executionCtx,
    );

    expect(response.status).toBe(200);
    // Reading the body surfaces the encoding failure to the client…
    await expect(response.text()).rejects.toThrow(
      "UI-message stream encoding failed",
    );
    await Promise.all(waitUntilTasks);
    // …while the backstop still settles the admission conservatively (the
    // ambiguous-outcome terminal), never leaving the hold to the lease alarm.
    expect(settleUnknown).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(billUsage).not.toHaveBeenCalled();
  });

  test("returns protocol-native 429/503 before billing or provider dispatch", async () => {
    const executionCtx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const request = () =>
      new Request("https://api.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer eliza_cached",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });

    orgRateLimitResult = Response.json(
      { error: "Too many requests", code: "rate_limit_exceeded" },
      { status: 429, headers: { "Retry-After": "17" } },
    );
    const limited = await chatRoute.fetch(request(), {} as never, executionCtx);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("17");
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();

    orgRateLimitResult = null;
    orgRateLimitError = new TestOrgRateLimitCacheNotReadyError("warming");
    const warming = await chatRoute.fetch(request(), {} as never, executionCtx);
    expect(warming.status).toBe(503);
    expect(warming.headers.get("Retry-After")).toBe("1");
    await expect(warming.json()).resolves.toMatchObject({
      retryable: true,
    });
    expect(admitOrganizationInference).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });
});
