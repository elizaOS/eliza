/** Real Messages handlers and credit settler with controlled provider/analytics/ledger transports.
 * Proves receipt identity and one charge through deferred finish/abort races; no live provider or authorization claim. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";

// Spread the real module so other test files importing from "ai" are not
// stranded by the process-wide registry replacement; restore in afterAll.
const aiActual = require("ai") as Record<string, unknown>;

import { estimateTokens } from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as recordsActual from "@/lib/services/ai-billing-records";
// The REAL settler — explicitly NOT mocked. This is the component under test.
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import * as loggerActual from "@/lib/utils/logger";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";

// --- mock the AI SDK streamText (the only external boundary we drive) --------
let streamTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const streamText = mock((config: Record<string, unknown>) => {
  if (!streamTextImpl)
    throw new ElizaError("streamTextImpl not set", {
      code: "TEST_FIXTURE_UNCONFIGURED",
    });
  return streamTextImpl(config);
});
const generateText = mock(async () => ({
  text: "hello streamed world",
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  toolCalls: [],
  finishReason: "stop",
}));
mock.module("ai", () => ({
  ...aiActual,
  streamText,
  generateText,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getLanguageModel: () => ({}) as never,
}));

const INPUT_TOKEN_COST = 0.001;
const OUTPUT_TOKEN_COST = 0.01;
let billUsageGate: Promise<void> | undefined;
const billUsage = mock(async (_context: unknown, usage: unknown) => {
  await billUsageGate;
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
const recordUsageAnalytics = mock(async () => null);
const recordLedger = mock(async (_input: Record<string, unknown>) => ({
  id: "ledger-receipt",
}));
mock.module("@/lib/services/ai-billing-records", () => ({
  ...recordsActual,
  aiBillingRecordsService: { record: recordLedger },
}));
const ledgerErrors: unknown[] = [];
mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    error: (message: string, fields: unknown) => {
      if (message.includes("billing ledger record failed"))
        ledgerErrors.push(fields);
    },
  },
}));
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  billUsage,
  recordUsageAnalytics,
}));

// Import the route AFTER the mocks so it binds to the stubs.
const { __messagesStreamingCreditTestHooks } = await import(
  "../v1/messages/route"
);
const { handleStream, handleNonStream } = __messagesStreamingCreditTestHooks;

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module("@/lib/services/ai-billing-records", () => recordsActual);
  mock.module("@/lib/utils/logger", () => loggerActual);
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
        return {
          reservedAmount: hold,
          actualCost,
          reservationTransactionId: "reserved-tx",
          settlementTransactionIds: ["settled-tx"],
          adjustmentType: "refund" as const,
        };
      },
    },
  };
}

const MODEL = "gpt-oss-120b";
const REQUEST = {
  model: MODEL,
  max_tokens: 256,
  messages: [{ role: "user", content: "hello" }],
  stream: true,
} as never;

/** Invoke handleStream with the test's settler and a fixed request shape. */
function callStreaming(
  settleReservation: (actualCost: number) => Promise<unknown> | unknown,
  options: {
    estimatedInputTokens?: number;
    signal?: AbortSignal;
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    settleUnknownReservation?: () => Promise<unknown> | unknown;
  } = {},
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
    (options.settleUnknownReservation ?? (async () => null)) as never,
    undefined,
    "gateway" as never,
    "req-ledger",
    options.executionCtx,
  );
}

beforeEach(() => {
  streamText.mockClear();
  generateText.mockClear();
  recordLedger.mockClear();
  ledgerErrors.length = 0;
  billUsageGate = undefined;
  billUsage.mockClear();
  recordUsageAnalytics.mockClear();
  streamTextImpl = null;
});

function callNonStreaming(
  settleReservation: (actualCost: number) => Promise<unknown> | unknown,
  options: {
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    providerDispatchTelemetry?: {
      capture(): void;
      emit(): void;
    };
    settleUnknownReservation?: () => Promise<unknown> | unknown;
  } = {},
) {
  return handleNonStream(
    MODEL,
    undefined,
    [{ role: "user", content: [{ type: "text", text: "hello" }] }] as never,
    {
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: "user", content: "hello" }],
    } as never,
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
    (options.settleUnknownReservation ?? (async () => null)) as never,
    undefined,
    "gateway" as never,
    "req-ledger",
    options.executionCtx,
    options.providerDispatchTelemetry,
  );
}

const TEXT = "hello streamed world";
const USAGE = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
const paths = ["nonstream", "finish", "abort"] as const;
for (const path of paths) {
  describe(`Messages ${path} ledger continuity`, () => {
    test.each([false, true])(
      "writes one receipt after analytics failure; ledger fails=%s",
      async (fails) => {
        const ledger = makeLedgerReservation(100, 0.2);
        const settle = createCreditReservationSettler(ledger.reservation);
        const unknown = mock(async () => settle(0.2));
        const pending: Promise<unknown>[] = [];
        const executionCtx = {
          waitUntil: (promise: Promise<unknown>) => {
            pending.push(promise);
          },
        };
        let release!: () => void;
        billUsageGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        if (fails)
          recordLedger.mockImplementationOnce(async () => {
            throw new ElizaError("ledger failed", {
              code: "TEST_LEDGER_UNAVAILABLE",
            });
          });
        streamTextImpl = (config) => {
          const finish = config.onFinish as (event: {
            text: string;
            totalUsage: typeof USAGE;
          }) => Promise<void>;
          const abort = config.onAbort as (event: {
            steps: [];
          }) => Promise<void>;
          return {
            fullStream: (async function* () {
              yield { type: "text-start", id: "text-1" };
              yield { type: "text-delta", id: "text-1", text: TEXT };
              // Both callback orders exercise the production single-flight guard.
              if (path === "abort") {
                await abort({ steps: [] });
                await finish({ text: TEXT, totalUsage: USAGE });
              } else {
                await finish({ text: TEXT, totalUsage: USAGE });
                await abort({ steps: [] });
              }
              yield { type: "finish", finishReason: "stop", totalUsage: USAGE };
            })(),
          };
        };
        try {
          const response =
            path === "nonstream"
              ? await callNonStreaming(settle, {
                  executionCtx,
                  settleUnknownReservation: unknown,
                })
              : await callStreaming(settle, {
                  executionCtx,
                  estimatedInputTokens: 12,
                  settleUnknownReservation: unknown,
                });
          const output = await response.text();
          expect(output).toContain(TEXT);
          expect(recordLedger).not.toHaveBeenCalled();
          expect(ledger.reconcileCalls).toBe(0);
        } finally {
          release();
          await Promise.all(pending);
        }
        const expectedCost =
          path === "abort"
            ? 12 * INPUT_TOKEN_COST + estimateTokens(TEXT) * OUTPUT_TOKEN_COST
            : 2 * INPUT_TOKEN_COST + 3 * OUTPUT_TOKEN_COST;
        expect(ledger.reconcileCalls).toBe(1);
        expect(ledger.actualCosts).toEqual([expectedCost]);
        expect(ledger.balance).toBeCloseTo(100 - expectedCost, 10);
        expect(billUsage).toHaveBeenCalledTimes(1);
        expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
        expect(recordLedger).toHaveBeenCalledTimes(1);
        expect(unknown).not.toHaveBeenCalled();
        expect(recordLedger.mock.calls[0][0]).toMatchObject({
          idempotencyKey: "req-ledger",
          usageRecord: null,
          context: {
            requestId: "req-ledger",
            organizationId: ORG,
            userId: USER,
          },
          reconciliation: {
            actualCost: expectedCost,
            reservationTransactionId: "reserved-tx",
            settlementTransactionIds: ["settled-tx"],
          },
        });
        expect(ledgerErrors).toHaveLength(fails ? 1 : 0);
      },
    );
  });
}

test("unknown finish usage retains the admitted estimate without fabricating a metered ledger row", async () => {
  const ledger = makeLedgerReservation(100, 0.2);
  const settle = createCreditReservationSettler(ledger.reservation);
  const unknown = mock(async () => settle(0.2));
  streamTextImpl = (config) => {
    const finish = config.onFinish as (event: {
      text: string;
      totalUsage: object;
    }) => Promise<void>;
    return {
      fullStream: (async function* () {
        yield { type: "text-start", id: "t" };
        yield { type: "text-delta", id: "t", text: TEXT };
        await finish({ text: TEXT, totalUsage: {} });
        yield { type: "finish", finishReason: "stop", totalUsage: {} };
      })(),
    };
  };
  await (
    await callStreaming(settle, { settleUnknownReservation: unknown })
  ).text();
  expect(unknown).toHaveBeenCalledTimes(1);
  expect(ledger.reconcileCalls).toBe(1);
  expect(ledger.actualCosts).toEqual([0.2]);
  expect(billUsage).not.toHaveBeenCalled();
  expect(recordLedger).not.toHaveBeenCalled();
});
