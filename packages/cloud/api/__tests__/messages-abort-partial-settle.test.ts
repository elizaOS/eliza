/**
 * Money-leak reproduction tests for POST /api/v1/messages streaming (#11513).
 *
 * A credit reservation is a ~1.5x upfront hold that MUST be settled — to actual
 * usage on success, to the delivered partial cost on client abort, or released
 * to 0 on provider failure. Before the fix, a client abort settled the
 * reservation to 0 (full refund) even though the platform had already paid the
 * upstream provider for the prompt and every token streamed before the
 * disconnect — an uncollected-revenue leak. /v1/chat/completions was fixed in
 * #11455/#11472; this suite locks the same behavior into /v1/messages.
 *
 * These tests drive the REAL credit-reservation settler
 * (`createCreditReservationSettler`, not a mock) against a ledger-backed
 * reservation and assert:
 *
 *   1. A client abort after text deltas settles to prompt + delivered-output
 *      cost — NOT 0 — via the `onAbort` callback path.
 *   2. The same partial settlement happens on the stream-catch path (request
 *      signal aborted, enqueue/iteration throw racing ahead of onAbort).
 *   3. onAbort + the catch backstop racing each other single-flight the
 *      settlement (billed and recorded exactly once).
 *   4. A provider error (no client abort) still refunds the hold in full and
 *      bills nothing.
 *
 * `streamText`, `getLanguageModel`, and the billing boundary are mocked at the
 * module seam; the settler and reservation math are real.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real module so other test files importing from "ai" are not
// stranded by the process-wide registry replacement; restore in afterAll.
const aiActual = require("ai") as Record<string, unknown>;

import { estimateTokens } from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";

// The REAL settler — explicitly NOT mocked. This is the component under test.
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";

// --- mock the AI SDK streamText (the only external boundary we drive) --------
let streamTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const streamText = mock((config: Record<string, unknown>) => {
  if (!streamTextImpl) throw new Error("streamTextImpl not set");
  return streamTextImpl(config);
});
mock.module("ai", () => ({
  ...aiActual,
  streamText,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getLanguageModel: () => ({}) as never,
}));

const INPUT_TOKEN_COST = 0.001;
const OUTPUT_TOKEN_COST = 0.01;
const billUsage = mock(async (_context: unknown, usage: unknown) => {
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
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  billUsage,
  recordUsageAnalytics,
}));

// Import the route AFTER the mocks so it binds to the stubs.
const { __messagesStreamingCreditTestHooks } = await import(
  "../v1/messages/route"
);
const { handleStream } = __messagesStreamingCreditTestHooks;

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
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
const REQUEST = {
  model: MODEL,
  max_tokens: 256,
  messages: [{ role: "user", content: "hello" }],
  stream: true,
} as never;

/** Invoke handleStream with the test's settler and a fixed request shape. */
function callStreaming(
  settleReservation: (actualCost: number) => Promise<unknown> | unknown,
  options: { estimatedInputTokens?: number; signal?: AbortSignal } = {},
) {
  return handleStream(
    MODEL,
    undefined,
    [{ role: "user", content: [{ type: "text", text: "hello" }] }] as never,
    REQUEST,
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
  );
}

beforeEach(() => {
  streamText.mockClear();
  billUsage.mockClear();
  recordUsageAnalytics.mockClear();
  streamTextImpl = null;
});

describe("streaming messages — client abort settles delivered usage (#11513)", () => {
  test("abort after text deltas reconciles to prompt plus delivered-output cost, not 0", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    const estimatedInputTokens = 12;
    const deliveredText = "partial response already sent";
    const expectedCost =
      estimatedInputTokens * INPUT_TOKEN_COST +
      estimateTokens(deliveredText) * OUTPUT_TOKEN_COST;
    expect(expectedCost).toBeGreaterThan(0);

    let onAbortPromise: Promise<unknown> | undefined;
    streamTextImpl = (config) => {
      const onAbort = config.onAbort as
        | ((event: { steps: [] }) => Promise<unknown> | unknown)
        | undefined;

      return {
        fullStream: (async function* () {
          yield { type: "text-start", id: "text-1" };
          yield {
            type: "text-delta",
            id: "text-1",
            text: deliveredText,
          };
          onAbortPromise = Promise.resolve(onAbort?.({ steps: [] }));
          yield { type: "abort", reason: "client disconnected" };
        })(),
      };
    };

    const res = await callStreaming(settle, { estimatedInputTokens });
    const body = await res.text();
    expect(onAbortPromise).toBeDefined();
    await onAbortPromise;

    expect(body).toContain(deliveredText);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeGreaterThan(0);
    expect(ledger.actualCosts[0]).toBeCloseTo(expectedCost, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - expectedCost, 10);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
  });

  test("request-signal abort after text deltas settles partial usage on the catch path", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    const controller = new AbortController();
    const estimatedInputTokens = 8;
    const deliveredText = "sent before disconnect";
    const expectedCost =
      estimatedInputTokens * INPUT_TOKEN_COST +
      estimateTokens(deliveredText) * OUTPUT_TOKEN_COST;

    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield { type: "text-start", id: "text-1" };
        yield {
          type: "text-delta",
          id: "text-1",
          text: deliveredText,
        };
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      })(),
    });

    const res = await callStreaming(settle, {
      estimatedInputTokens,
      signal: controller.signal,
    });
    const body = await res.text();

    expect(body).toContain(deliveredText);
    expect(ledger.reconcileCalls).toBe(1);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(expectedCost, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - expectedCost, 10);
  });

  test("onAbort plus cancelled-controller catch single-flights partial settlement", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    const controller = new AbortController();
    const estimatedInputTokens = 8;
    const deliveredText = "sent before disconnect";
    let onAbortPromise: Promise<unknown> | undefined;

    streamTextImpl = (config) => {
      const onAbort = config.onAbort as
        | ((event: { steps: [] }) => Promise<unknown> | unknown)
        | undefined;

      return {
        fullStream: (async function* () {
          yield { type: "text-start", id: "text-1" };
          yield {
            type: "text-delta",
            id: "text-1",
            text: deliveredText,
          };
          controller.abort();
          onAbortPromise = Promise.resolve(onAbort?.({ steps: [] }));
          throw new DOMException("The operation was aborted.", "AbortError");
        })(),
      };
    };

    const res = await callStreaming(settle, {
      estimatedInputTokens,
      signal: controller.signal,
    });
    await res.text();
    expect(onAbortPromise).toBeDefined();
    await onAbortPromise;

    expect(ledger.reconcileCalls).toBe(1);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
    expect(ledger.actualCosts[0]).toBeGreaterThan(0);
  });
});

describe("streaming messages — provider failure still refunds in full", () => {
  test("fullStream error without a client abort releases the reservation to 0 and bills nothing", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    expect(ledger.balance).toBe(100 - 0.015);

    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield { type: "error", error: new Error("provider returned 503") };
      })(),
    });

    const res = await callStreaming(settle);
    const body = await res.text();

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([0]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
    expect(billUsage).not.toHaveBeenCalled();
    expect(recordUsageAnalytics).not.toHaveBeenCalled();
    expect(body).toContain('"type":"error"');
  });

  test("onError provider failure releases the reservation to 0", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);

    const err = new Error("provider returned 429");
    let onErrorPromise: Promise<unknown> | undefined;
    streamTextImpl = (config) => {
      const onError = config.onError as
        | ((e: { error: unknown }) => Promise<unknown>)
        | undefined;
      onErrorPromise = Promise.resolve(onError?.({ error: err }));
      return {
        fullStream: (async function* () {
          yield { type: "error", error: err };
        })(),
      };
    };

    const res = await callStreaming(settle);
    await res.text();
    await onErrorPromise;

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([0]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
    expect(billUsage).not.toHaveBeenCalled();
  });
});
