/**
 * Off-response-path billing tests for POST /api/v1/messages (#15414).
 *
 * Before the fix, the streaming path's `onFinish` awaited the settlement chain
 * (billUsage → settleReservation → recordUsageAnalytics) INLINE, and the AI SDK
 * awaits `onFinish` before it ends `fullStream` — so the terminal SSE frames
 * (message_delta + message_stop) were held hostage for the full billing-write
 * latency (~8s measured for the identical pattern on /v1/chat/completions,
 * fixed in #15412). The non-stream handler had the same bug: it awaited the
 * chain before `Response.json` returned.
 *
 * These tests drive the REAL credit-reservation settler
 * (`createCreditReservationSettler`, not a mock) against a ledger-backed
 * reservation and assert:
 *
 *   1. STREAM: the terminal frames flush while billUsage is still gated open —
 *      the chain is handed to `executionCtx.waitUntil` and settles exactly once
 *      with the same amounts after release.
 *   2. NON-STREAM: the Response returns while billUsage is still gated open —
 *      same waitUntil handoff, same amounts, exactly once.
 *   3. Parity: the deferred chain bills with EXACTLY the same args as the
 *      inline (no-executionCtx) fallback path.
 *   4. Abort mid-stream with an executionCtx still records the delivered
 *      partial usage (the abort settle path is unchanged by the deferral).
 *   5. A deferred billing failure logs and releases the reservation, but never
 *      breaks the already-sent response (stream already ended with
 *      message_stop; non-stream already returned 200 with provider usage).
 *   6. A stray late onError racing a deferred onFinish cannot double-settle
 *      (the settlement promise is cached synchronously inside onFinish).
 *
 * `streamText`/`generateText`, `getLanguageModel`, and the billing boundary are
 * mocked at the module seam; the settler and reservation math are real. Mirrors
 * `chat-completions-streaming-credit-leak.test.ts` (#15412's suite).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real module so other test files importing from "ai" are not
// stranded by the process-wide registry replacement; restore in afterAll.
const aiActual = require("ai") as Record<string, unknown>;

import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import { estimateTokens } from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";

// The REAL settler — explicitly NOT mocked. This is the component under test.
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";

// --- mock the AI SDK boundary we drive ---------------------------------------
let streamTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const streamText = mock((config: Record<string, unknown>) => {
  if (!streamTextImpl) throw new Error("streamTextImpl not set");
  return streamTextImpl(config);
});
let generateTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const generateText = mock(async (config: Record<string, unknown>) => {
  if (!generateTextImpl) throw new Error("generateTextImpl not set");
  return generateTextImpl(config);
});
mock.module("ai", () => ({
  ...aiActual,
  streamText,
  generateText,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getLanguageModel: () => ({}) as never,
}));

type InferenceAuthResolution = Awaited<
  ReturnType<typeof inferenceAuthContextActual.resolveInferenceAuthContext>
>;
const resolveInferenceAuthContext = mock(
  async (): Promise<InferenceAuthResolution> => ({
    kind: "authorized",
    ctx: {
      v: 1,
      cachedAt: 0,
      userId: USER,
      orgId: ORG,
      apiKeyId: API_KEY_ID,
      keyHash: "messages-billing-test-key",
    },
    source: "cache",
  }),
);
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthContextActual,
  resolveInferenceAuthContext,
}));

const shouldBlockUser = mock(async () => false);
const moderateInBackground = mock(() => undefined);
mock.module("@/lib/services/content-moderation", () => ({
  ...contentModerationActual,
  contentModerationService: {
    ...contentModerationActual.contentModerationService,
    shouldBlockUser,
    moderateInBackground,
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { ...rateLimitActual.RateLimitPresets, RELAXED: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const INPUT_TOKEN_COST = 0.001;
const OUTPUT_TOKEN_COST = 0.01;
// When set, billUsage blocks until the gate resolves — lets the waitUntil-
// parity tests hold the settlement chain open while the response is read, to
// prove neither the SSE close nor the JSON return waits on billing.
let billUsageGate: Promise<void> | null = null;
// When set, billUsage rejects — the deferred-failure tests.
let billUsageError: Error | null = null;
const billUsage = mock(async (_context: unknown, usage: unknown) => {
  if (billUsageGate) await billUsageGate;
  if (billUsageError) throw billUsageError;
  const record =
    usage && typeof usage === "object"
      ? (usage as {
          inputTokens?: number;
          promptTokens?: number;
          outputTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
        })
      : {};
  const inputTokens = record.inputTokens ?? record.promptTokens ?? 0;
  const outputTokens = record.outputTokens ?? record.completionTokens ?? 0;
  const inputCost = inputTokens * INPUT_TOKEN_COST;
  const outputCost = outputTokens * OUTPUT_TOKEN_COST;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    baseInputCost: inputCost,
    baseOutputCost: outputCost,
    baseTotalCost: inputCost + outputCost,
    platformMarkup: 0,
    inputTokens,
    outputTokens,
    totalTokens: record.totalTokens ?? inputTokens + outputTokens,
    markupApplied: true,
  };
});
const recordUsageAnalytics = mock(async () => ({ id: "usage-1" }));
let routeReservation:
  | ReturnType<typeof makeLedgerReservation>["reservation"]
  | null = null;
const reserveCredits = mock(async () => {
  if (!routeReservation) throw new Error("routeReservation not set");
  return routeReservation;
});
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  billUsage,
  recordUsageAnalytics,
  reserveCredits,
}));

// Import the route AFTER the mocks so it binds to the stubs.
const messagesRouteModule = await import("../v1/messages/route");
const { __messagesStreamingCreditTestHooks } = messagesRouteModule;
const messagesRoute = messagesRouteModule.default;
const { handleStream, handleNonStream } = __messagesStreamingCreditTestHooks;

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module(
    "@/lib/services/content-moderation",
    () => contentModerationActual,
  );
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthContextActual,
  );
});

/**
 * A faithful in-memory credit ledger. reserve() debits the ~1.5x hold up front;
 * reconcile(actualCost) refunds (hold - actualCost) back. reconcile(0) therefore
 * returns the full hold → balance restored to the pre-request value.
 */
function makeLedgerReservation(startBalance: number, hold: number) {
  let balance = startBalance - hold; // upfront hold debited
  let reconcileCalls = 0;
  const actualCosts: number[] = [];
  return {
    startBalance,
    hold,
    get balance() {
      return balance;
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    get actualCosts() {
      return actualCosts;
    },
    reservation: {
      reservedAmount: hold,
      reconcile: async (actualCost: number) => {
        reconcileCalls++;
        actualCosts.push(actualCost);
        balance += hold - actualCost;
        return undefined;
      },
    },
  };
}

const MODEL = "openai/gpt-oss-120b";
const STREAM_REQUEST = {
  model: MODEL,
  max_tokens: 256,
  messages: [{ role: "user", content: "hello" }],
  stream: true,
} as never;
const NONSTREAM_REQUEST = {
  model: MODEL,
  max_tokens: 256,
  messages: [{ role: "user", content: "hello" }],
} as never;

type ExecutionCtx = { waitUntil(promise: Promise<unknown>): void };

/** Invoke handleStream with the test's settler and a fixed request shape. */
function callStreaming(
  settleReservation: (actualCost: number) => Promise<unknown> | unknown,
  options: {
    estimatedInputTokens?: number;
    signal?: AbortSignal;
    executionCtx?: ExecutionCtx;
    providerDispatchTelemetry?: {
      capture(): void;
      emit(): void;
    };
  } = {},
) {
  return handleStream(
    MODEL,
    undefined,
    [{ role: "user", content: [{ type: "text", text: "hello" }] }] as never,
    STREAM_REQUEST,
    { id: USER, organization_id: ORG },
    null,
    null,
    Date.now(),
    options.estimatedInputTokens ?? 1,
    {} as never,
    undefined,
    undefined,
    options.signal,
    30_000,
    settleReservation as never,
    "gateway" as never,
    "req-test-offpath",
    options.executionCtx,
    options.providerDispatchTelemetry,
  );
}

/** Invoke handleNonStream with the test's settler and a fixed request shape. */
function callNonStreaming(
  settleReservation: (actualCost: number) => Promise<unknown> | unknown,
  options: {
    executionCtx?: ExecutionCtx;
    providerDispatchTelemetry?: {
      capture(): void;
      emit(): void;
    };
  } = {},
) {
  return handleNonStream(
    MODEL,
    undefined,
    [{ role: "user", content: [{ type: "text", text: "hello" }] }] as never,
    NONSTREAM_REQUEST,
    { id: USER, organization_id: ORG },
    null,
    null,
    Date.now(),
    {} as never,
    undefined,
    undefined,
    undefined,
    30_000,
    settleReservation as never,
    "gateway" as never,
    "req-test-offpath",
    options.executionCtx,
    options.providerDispatchTelemetry,
  );
}

beforeEach(() => {
  streamText.mockClear();
  generateText.mockClear();
  billUsage.mockClear();
  recordUsageAnalytics.mockClear();
  streamTextImpl = null;
  generateTextImpl = null;
  billUsageGate = null;
  billUsageError = null;
  routeReservation = null;
  reserveCredits.mockClear();
  resolveInferenceAuthContext.mockReset();
  resolveInferenceAuthContext.mockResolvedValue({
    kind: "authorized",
    ctx: {
      v: 1,
      cachedAt: 0,
      userId: USER,
      orgId: ORG,
      apiKeyId: API_KEY_ID,
      keyHash: "messages-billing-test-key",
    },
    source: "cache",
  });
  shouldBlockUser.mockReset();
  shouldBlockUser.mockResolvedValue(false);
  moderateInBackground.mockClear();
});

const USAGE = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
const TEXT = "hello streamed world";
const EXPECTED_COST =
  USAGE.inputTokens * INPUT_TOKEN_COST + USAGE.outputTokens * OUTPUT_TOKEN_COST;

/**
 * SDK-faithful stream: the AI SDK AWAITS onFinish before ending fullStream —
 * that contract is exactly why an inline-awaited settlement chain held the
 * terminal SSE frames (message_delta + message_stop) hostage. Also captures
 * onError so the deferral tests can fire a stray late error against the
 * cached settlement.
 */
function sdkFaithfulStream(): { onError: () => Promise<unknown> } {
  let capturedOnError:
    | ((e: { error: unknown }) => Promise<unknown>)
    | undefined;
  streamTextImpl = (config) => {
    capturedOnError = config.onError as typeof capturedOnError;
    const onFinish = config.onFinish as (event: {
      text: string;
      totalUsage: typeof USAGE;
    }) => Promise<unknown>;
    return {
      fullStream: (async function* () {
        yield { type: "text-start", id: "text-1" };
        yield { type: "text-delta", id: "text-1", text: TEXT };
        yield { type: "text-end", id: "text-1" };
        await onFinish({ text: TEXT, totalUsage: USAGE });
        yield { type: "finish", finishReason: "stop", totalUsage: USAGE };
      })(),
    };
  };
  return {
    onError: () =>
      Promise.resolve(
        capturedOnError?.({ error: new Error("provider returned 503") }),
      ),
  };
}

function sdkFaithfulGeneration() {
  generateTextImpl = () => ({
    text: TEXT,
    usage: USAGE,
    toolCalls: [],
    finishReason: "stop",
    rawFinishReason: "stop",
  });
}

function postMessages(bodyOverrides: Record<string, unknown> = {}) {
  return messagesRoute.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "eliza_test_key",
      "x-eliza-trace-id": "22222222-2222-4222-8222-222222222222",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: "user", content: "hello" }],
      ...bodyOverrides,
    }),
  });
}

describe("messages route preforward telemetry", () => {
  // #16081 invariant on /v1/messages: MODEL (gpt-oss-120b) is a reasoning model,
  // so the provider's maxOutputTokens is floored ABOVE the requested 256. The
  // reservation must admit that same floored ceiling — reserving the raw 256
  // would let the provider bill far more output than was reserved.
  test("reserves the same reasoning-floored ceiling the provider is capped at", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    routeReservation = ledger.reservation;
    let capturedConfig: Record<string, unknown> | undefined;
    generateTextImpl = (config) => {
      capturedConfig = config;
      return {
        text: TEXT,
        usage: USAGE,
        toolCalls: [],
        finishReason: "stop",
        rawFinishReason: "stop",
      };
    };
    reserveCredits.mockClear();

    const response = await postMessages(); // gpt-oss-120b, max_tokens: 256
    expect(response.status).toBe(200);

    const providerCap = capturedConfig?.maxOutputTokens as number;
    // Reasoning model → the provider cap is floored above the requested 256.
    expect(providerCap).toBeGreaterThan(256);
    // The reservation admitted that exact ceiling (3rd arg to reserveCredits),
    // not the raw request.max_tokens.
    const reserveArgs = reserveCredits.mock.calls[0] as unknown as
      | [unknown, number, number]
      | undefined;
    expect(reserveArgs?.[2]).toBe(providerCap);
  });

  // Streaming sibling of the reservation-parity test above: the stream handler
  // recomputes the same floored ceiling before streamText, and the reservation
  // taken by the route (before the stream/non-stream fork) must match it.
  test("streaming: reserves the same reasoning-floored ceiling streamText is capped at", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    routeReservation = ledger.reservation;
    let capturedConfig: Record<string, unknown> | undefined;
    // sdkFaithfulStream doesn't expose the streamText config, so re-inline its
    // SDK-faithful stream shape with a config capture.
    streamTextImpl = (config) => {
      capturedConfig = config;
      const onFinish = config.onFinish as (event: {
        text: string;
        totalUsage: typeof USAGE;
      }) => Promise<unknown>;
      return {
        fullStream: (async function* () {
          yield { type: "text-start", id: "text-1" };
          yield { type: "text-delta", id: "text-1", text: TEXT };
          yield { type: "text-end", id: "text-1" };
          await onFinish({ text: TEXT, totalUsage: USAGE });
          yield { type: "finish", finishReason: "stop", totalUsage: USAGE };
        })(),
      };
    };
    reserveCredits.mockClear();

    const response = await postMessages({ stream: true }); // gpt-oss-120b, max_tokens: 256
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"type":"message_stop"');

    const providerCap = capturedConfig?.maxOutputTokens as number;
    // Reasoning model → the streamText cap is floored above the requested 256.
    expect(providerCap).toBeGreaterThan(256);
    const reserveArgs = reserveCredits.mock.calls[0] as unknown as
      | [unknown, number, number]
      | undefined;
    expect(reserveArgs?.[2]).toBe(providerCap);
  });

  // Pass-through regression: for a NON-reasoning model the floor must not
  // fire — the reservation admits exactly the requested max_tokens, and the
  // provider is capped at the same value.
  test("non-reasoning model: reservation passes request.max_tokens through unfloored", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    routeReservation = ledger.reservation;
    let capturedConfig: Record<string, unknown> | undefined;
    generateTextImpl = (config) => {
      capturedConfig = config;
      return {
        text: TEXT,
        usage: USAGE,
        toolCalls: [],
        finishReason: "stop",
        rawFinishReason: "stop",
      };
    };
    reserveCredits.mockClear();

    const response = await postMessages({
      model: "openai/gpt-4o-mini",
      max_tokens: 512,
    });
    expect(response.status).toBe(200);

    // No floor: provider cap and reservation both equal the raw request value.
    expect(capturedConfig?.maxOutputTokens).toBe(512);
    const reserveArgs = reserveCredits.mock.calls[0] as unknown as
      | [unknown, number, number]
      | undefined;
    expect(reserveArgs?.[2]).toBe(512);
  });

  test("non-stream success preserves trace and the frozen provider boundary", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    routeReservation = ledger.reservation;
    sdkFaithfulGeneration();

    const response = await postMessages();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Eliza-Trace-Id")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(response.headers.get("X-Eliza-Preforward-Ms")).toMatch(
      /^total=\d+(?:\.\d+)?;auth=\d+(?:\.\d+)?;mid=\d+(?:\.\d+)?;reserve=\d+(?:\.\d+)?;setup=\d+(?:\.\d+)?$/,
    );
    expect(response.headers.get("Server-Timing")).toContain(
      "gateway_preforward;dur=",
    );
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(EXPECTED_COST, 10);
  });

  test("stream success preserves telemetry without delaying or re-encoding SSE", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    routeReservation = ledger.reservation;
    sdkFaithfulStream();

    const response = await postMessages({ stream: true });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(TEXT);
    expect(body).toContain('"type":"message_stop"');
    expect(response.headers.get("X-Eliza-Trace-Id")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(response.headers.get("Server-Timing")).toContain(
      "gateway_preforward;dur=",
    );
    expect(ledger.reconcileCalls).toBe(1);
  });

  test("synchronous provider errors retain timing and release the reservation", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    routeReservation = ledger.reservation;
    generateTextImpl = () => {
      throw new Error("provider setup failed");
    };

    const response = await postMessages();
    expect(response.status).toBe(500);
    expect(response.headers.get("X-Eliza-Trace-Id")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(response.headers.get("X-Eliza-Preforward-Ms")).toContain("total=");
    expect(response.headers.get("Server-Timing")).toContain(
      "gateway_preforward;dur=",
    );
    expect(ledger.actualCosts).toEqual([0]);
  });

  test("suspended and malformed requests stop before reserve/provider dispatch", async () => {
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "suspended",
      userId: USER,
    });
    expect((await postMessages()).status).toBe(403);

    const malformed = await postMessages({ max_tokens: null });
    expect(malformed.status).toBe(400);
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });
});

describe("streaming messages — billing settles OFF the response path (waitUntil parity, #15414)", () => {
  test("captures the preforward boundary immediately around streamText", async () => {
    const events: string[] = [];
    sdkFaithfulStream();
    const originalStreamText = streamTextImpl!;
    streamTextImpl = (config) => {
      events.push("streamText");
      return originalStreamText(config);
    };
    const response = await callStreaming(async () => null, {
      providerDispatchTelemetry: {
        capture: () => events.push("capture"),
        emit: () => events.push("emit"),
      },
    });

    await response.text();
    expect(events).toEqual(["capture", "streamText", "emit"]);
  });

  test("terminal frames + message_stop flush BEFORE the billing chain completes; the chain runs via waitUntil", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);

    // Hold the settlement chain open at its first DB write (billUsage).
    let releaseBilling!: () => void;
    billUsageGate = new Promise<void>((resolve) => {
      releaseBilling = resolve;
    });

    const waitUntilPromises: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
    };

    sdkFaithfulStream();
    const res = await callStreaming(settle, { executionCtx });
    // Reading the WHOLE body to message_stop completes while billUsage is
    // still gated — the regression under test (the ~8s billing tail) would
    // hang this read until the chain finished.
    const body = await res.text();
    expect(body).toContain(TEXT);
    expect(body).toContain('"type":"message_stop"');
    expect(ledger.reconcileCalls).toBe(0); // nothing settled at stream close
    expect(waitUntilPromises.length).toBe(1); // chain handed to waitUntil

    releaseBilling();
    await Promise.all(waitUntilPromises);

    // The deferred chain ran exactly once, with the same amounts as before.
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(EXPECTED_COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - EXPECTED_COST, 10);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
  });

  test("deferred chain bills with EXACTLY the same args as the inline (no-executionCtx) path", async () => {
    // Deferred variant.
    const waitUntilPromises: Promise<unknown>[] = [];
    sdkFaithfulStream();
    const deferredRes = await callStreaming(async () => null, {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    await deferredRes.text();
    await Promise.all(waitUntilPromises);
    expect(billUsage).toHaveBeenCalledTimes(1);
    const deferredCall = billUsage.mock.calls[0];

    // Inline variant (tests / non-Worker fallback): same scenario, no ctx.
    billUsage.mockClear();
    sdkFaithfulStream();
    const inlineRes = await callStreaming(async () => null, {});
    await inlineRes.text();
    expect(billUsage).toHaveBeenCalledTimes(1);

    // Parity: billing context (ids, requestId, source) + usage match.
    expect(deferredCall).toEqual(billUsage.mock.calls[0]);
  });

  test("without executionCtx the chain settles inline by stream close (behavior unchanged)", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);

    sdkFaithfulStream();
    const res = await callStreaming(settle, {});
    const body = await res.text();

    expect(body).toContain('"type":"message_stop"');
    expect(ledger.reconcileCalls).toBe(1); // settled before the body closed
    expect(ledger.actualCosts[0]).toBeCloseTo(EXPECTED_COST, 10);
  });

  test("a stray late onError after a deferred onFinish cannot double-settle", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    const waitUntilPromises: Promise<unknown>[] = [];

    const stream = sdkFaithfulStream();
    const res = await callStreaming(settle, {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    await res.text();
    // The settlement promise is cached synchronously inside onFinish, so an
    // onError racing in BEFORE the deferred chain resolves observes the same
    // settlement instead of issuing a refund.
    await stream.onError();
    await Promise.all(waitUntilPromises);

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(EXPECTED_COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - EXPECTED_COST, 10);
  });

  test("client abort mid-stream with an executionCtx still records the delivered partial usage", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    const estimatedInputTokens = 12;
    const deliveredText = "partial response already sent";
    const expectedCost =
      estimatedInputTokens * INPUT_TOKEN_COST +
      estimateTokens(deliveredText) * OUTPUT_TOKEN_COST;

    let onAbortPromise: Promise<unknown> | undefined;
    streamTextImpl = (config) => {
      const onAbort = config.onAbort as
        | ((event: { steps: [] }) => Promise<unknown> | unknown)
        | undefined;
      return {
        fullStream: (async function* () {
          yield { type: "text-start", id: "text-1" };
          yield { type: "text-delta", id: "text-1", text: deliveredText };
          onAbortPromise = Promise.resolve(onAbort?.({ steps: [] }));
          yield { type: "abort", reason: "client disconnected" };
        })(),
      };
    };

    const waitUntilPromises: Promise<unknown>[] = [];
    const res = await callStreaming(settle, {
      estimatedInputTokens,
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    const body = await res.text();
    expect(onAbortPromise).toBeDefined();
    await onAbortPromise;
    await Promise.all(waitUntilPromises);

    // The abort settle path is unchanged by the deferral: the delivered
    // partial cost is still billed and recorded, never dropped.
    expect(body).toContain(deliveredText);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(expectedCost, 10);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
  });

  test("deferred billing failure releases the reservation and never breaks the already-sent stream", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    billUsageError = new Error("billing backend down");

    const waitUntilPromises: Promise<unknown>[] = [];
    sdkFaithfulStream();
    const res = await callStreaming(settle, {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    const body = await res.text();

    // The stream already completed normally — terminal frames intact.
    expect(body).toContain(TEXT);
    expect(body).toContain('"type":"message_stop"');
    expect(body).not.toContain('"type":"error"');

    // The deferred chain's failure branch released the hold (settle(0)).
    await Promise.all(waitUntilPromises);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([0]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });
});

describe("non-stream messages — billing settles OFF the response path (#15414 sibling)", () => {
  test("Response.json returns BEFORE the billing chain completes; the chain runs via waitUntil with provider usage in the body", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);

    let releaseBilling!: () => void;
    billUsageGate = new Promise<void>((resolve) => {
      releaseBilling = resolve;
    });

    const waitUntilPromises: Promise<unknown>[] = [];
    sdkFaithfulGeneration();
    const res = await callNonStreaming(settle, {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    // The Response arrived while billUsage is still gated — the regression
    // under test would have awaited the whole chain before returning.
    const json = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };
    expect(json.content[0]?.text).toBe(TEXT);
    // Usage in the body comes from the provider result, not the billing writes.
    expect(json.usage.input_tokens).toBe(USAGE.inputTokens);
    expect(json.usage.output_tokens).toBe(USAGE.outputTokens);
    expect(ledger.reconcileCalls).toBe(0); // nothing settled at response time
    expect(waitUntilPromises.length).toBe(1); // chain handed to waitUntil

    releaseBilling();
    await Promise.all(waitUntilPromises);

    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(EXPECTED_COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - EXPECTED_COST, 10);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
  });

  test("deferred chain bills with EXACTLY the same args as the inline (no-executionCtx) path", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    sdkFaithfulGeneration();
    await callNonStreaming(async () => null, {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    await Promise.all(waitUntilPromises);
    expect(billUsage).toHaveBeenCalledTimes(1);
    const deferredCall = billUsage.mock.calls[0];

    billUsage.mockClear();
    sdkFaithfulGeneration();
    await callNonStreaming(async () => null, {});
    expect(billUsage).toHaveBeenCalledTimes(1);

    expect(deferredCall).toEqual(billUsage.mock.calls[0]);
  });

  test("without executionCtx the chain settles inline before the Response returns (behavior unchanged)", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);

    sdkFaithfulGeneration();
    const res = await callNonStreaming(settle, {});
    expect(res.status).toBe(200);
    expect(ledger.reconcileCalls).toBe(1); // settled before return
    expect(ledger.actualCosts[0]).toBeCloseTo(EXPECTED_COST, 10);
  });

  test("deferred billing failure releases the reservation but the 200 with provider usage already went out", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    billUsageError = new Error("billing backend down");

    const waitUntilPromises: Promise<unknown>[] = [];
    sdkFaithfulGeneration();
    const res = await callNonStreaming(settle, {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(json.usage.input_tokens).toBe(USAGE.inputTokens);
    expect(json.usage.output_tokens).toBe(USAGE.outputTokens);

    await Promise.all(waitUntilPromises);
    // The failure branch released the hold instead of stranding it.
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([0]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });

  test("provider error before any response still refunds inline and rethrows (path unchanged)", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    generateTextImpl = () => {
      throw new Error("provider exploded");
    };

    await expect(
      callNonStreaming(settle, {
        executionCtx: {
          waitUntil() {
            throw new Error("waitUntil must not be reached on this path");
          },
        },
      }),
    ).rejects.toThrow("provider exploded");

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([0]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
    expect(billUsage).not.toHaveBeenCalled();
  });
});
