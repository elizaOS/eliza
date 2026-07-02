/**
 * Money-leak reproduction tests for POST /api/v1/messages streaming aborts
 * (#11513 — ports the /v1/chat/completions partial-settle fix from #11472).
 *
 * A credit reservation is a ~1.5x upfront hold that MUST be settled. Before
 * the fix, a client abort mid-stream settled the reservation to 0 — a FULL
 * refund — even though the tokens already streamed to the client were really
 * generated and really billed to us by the provider (under-collection on
 * every aborted stream). These tests drive the REAL credit-reservation
 * settler (`createCreditReservationSettler`, not a mock) against a
 * ledger-backed reservation and assert:
 *
 *   1. onAbort after delivered text deltas settles the reservation to
 *      estimated-input + delivered-output cost (> 0), with billUsage called
 *      exactly once — not a settleReservation(0) full refund.
 *   2. A request-signal abort surfacing as an AbortError throw in the outer
 *      stream catch (SDK onAbort never invoked) takes the same partial-settle
 *      path.
 *   3. onAbort racing the outer catch single-flights the settlement: one
 *      reconcile, one billUsage, one analytics record.
 *   4. A provider failure WITHOUT a request abort still refunds to 0 and
 *      never bills (aborts are the only non-finish path that pays).
 *
 * `streamText`, `getLanguageModel`, and the billing-price lookup are mocked at
 * the module boundary; the settler and reservation math are real.
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
const { __streamingCreditTestHooks } = await import("../v1/messages/route");
const { handleStream } = __streamingCreditTestHooks;

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
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 256,
  stream: true,
} as never;

/** Invoke handleStream with the test's settler and a fixed shape. */
function callStream(
  settleReservation: (actualCost: number) => Promise<unknown> | unknown,
  options: { estimatedInputTokens?: number; signal?: AbortSignal } = {},
) {
  return handleStream(
    MODEL,
    undefined,
    [{ role: "user", content: "hello" }] as never,
    REQUEST,
    { id: USER, organization_id: ORG },
    null,
    null,
    Date.now(),
    options.estimatedInputTokens ?? 1,
    {} as never,
    undefined as never,
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

describe("streaming /v1/messages — client abort settles delivered usage", () => {
  test("abort after text deltas reconciles to prompt plus delivered-output cost, not 0", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    // Sanity: the upfront hold has already debited the balance.
    expect(ledger.balance).toBe(100 - 0.015);

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

    const res = await callStream(settle, { estimatedInputTokens });
    const body = await res.text();
    expect(onAbortPromise).toBeDefined();
    await onAbortPromise;

    expect(body).toContain(deliveredText);
    // The delivered tokens were BILLED (partial settle), not full-refunded.
    expect(ledger.reconcileCalls).toBe(1);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(ledger.actualCosts[0]).toBeGreaterThan(0);
    expect(ledger.actualCosts[0]).toBeCloseTo(expectedCost, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - expectedCost, 10);
    // The analytics record carries the aborted marker path (isSuccessful:false).
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
  });

  test("request-signal abort surfacing in the outer catch settles partial usage", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    const controller = new AbortController();
    const estimatedInputTokens = 8;
    const deliveredText = "sent before disconnect";
    const expectedCost =
      estimatedInputTokens * INPUT_TOKEN_COST +
      estimateTokens(deliveredText) * OUTPUT_TOKEN_COST;

    // SDK onAbort never invoked — only the AbortError throw in the fullStream
    // loop. The outer catch must take the abort-partial-settle branch.
    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield {
          type: "text-delta",
          id: "text-1",
          text: deliveredText,
        };
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      })(),
    });

    const res = await callStream(settle, {
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

  test("onAbort plus aborted-signal outer catch single-flights partial settlement", async () => {
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

    const res = await callStream(settle, {
      estimatedInputTokens,
      signal: controller.signal,
    });
    await res.text();
    expect(onAbortPromise).toBeDefined();
    await onAbortPromise;

    // Both the onAbort callback and the outer catch fired; the settlement
    // composed once: one reconcile, one billUsage, one analytics record.
    expect(ledger.reconcileCalls).toBe(1);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
    expect(ledger.actualCosts[0]).toBeGreaterThan(0);
  });

  test("provider failure without request abort refunds to 0 and does not bill", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    const deliveredText = "sent before provider failure";

    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield {
          type: "text-delta",
          id: "text-1",
          text: deliveredText,
        };
        throw new DOMException("upstream connection aborted", "AbortError");
      })(),
    });

    const res = await callStream(settle);
    const body = await res.text();

    expect(body).toContain(deliveredText);
    expect(body).toContain('"type":"error"');
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([0]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
    expect(billUsage).not.toHaveBeenCalled();
    expect(recordUsageAnalytics).not.toHaveBeenCalled();
  });
});
