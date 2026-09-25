/** Exercises settled passthrough billing with the real streaming handler and credit
 * settler. Provider/analytics/ledger transports are controlled; authorization and
 * a live provider are outside this fixture. Analytics failure still attempts one
 * ledger write, and a ledger failure neither changes delivered bytes nor settles
 * the charge again.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";

// Spread the real module so other test files importing from "ai" are not
// stranded by the process-wide registry replacement; restore in afterAll.
const aiActual = require("ai") as Record<string, unknown>;

import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as aiBillingRecordsActual from "@/lib/services/ai-billing-records";
import * as teamCredentialPoolActual from "@/lib/services/team-credential-pool";
// The REAL settler — explicitly NOT mocked; reservation math is under test.
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import * as loggerActual from "@/lib/utils/logger";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
// Actual Cerebras model identity used by this bounded settlement fixture.
const MODEL = "gpt-oss-120b";

// --- module mocks (same boundaries as the sibling streaming suites) ---------
let generateTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const generateText = mock((config: Record<string, unknown>) => {
  if (!generateTextImpl)
    throw new ElizaError("generateTextImpl not set", {
      code: "TEST_FIXTURE_UNCONFIGURED",
    });
  return generateTextImpl(config);
});
let streamTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const streamText = mock((config: Record<string, unknown>) => {
  if (!streamTextImpl)
    throw new ElizaError("streamTextImpl not set", {
      code: "TEST_FIXTURE_UNCONFIGURED",
    });
  return streamTextImpl(config);
});
mock.module("ai", () => ({
  ...aiActual,
  generateText,
  streamText,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getLanguageModel: () => ({}) as never,
}));

const INPUT_TOKEN_COST = 0.001;
const OUTPUT_TOKEN_COST = 0.01;
// When set, billUsage blocks until the gate resolves — the waitUntil test
// holds the settle chain open to prove the piped bytes never wait on billing.
let billUsageGate: Promise<void> | null = null;
const billUsage = mock(async (_context: unknown, usage: unknown) => {
  if (billUsageGate) await billUsageGate;
  const record =
    usage && typeof usage === "object"
      ? (usage as {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        })
      : {};
  const inputTokens = record.inputTokens ?? 0;
  const outputTokens = record.outputTokens ?? 0;
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
const recordUsageAnalytics = mock(
  async (): Promise<{ id: string } | null> => ({ id: "usage-1" }),
);
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  billUsage,
  recordUsageAnalytics,
}));

const aiBillingRecord = mock(async () => ({ id: "billing-record-1" }));
mock.module("@/lib/services/ai-billing-records", () => ({
  ...aiBillingRecordsActual,
  aiBillingRecordsService: {
    ...aiBillingRecordsActual.aiBillingRecordsService,
    record: aiBillingRecord,
  },
}));

const poolRecordUse = mock(async () => {});
const poolRecordProviderFailure = mock(async () => {});
mock.module("@/lib/services/team-credential-pool", () => ({
  ...teamCredentialPoolActual,
  getTeamPoolRegistry: () => ({
    recordUse: poolRecordUse,
    recordProviderFailure: poolRecordProviderFailure,
  }),
}));

const errorCalls: Array<{ message: string; context: unknown }> = [];
mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    error(message: string, context?: unknown) {
      errorCalls.push({ message, context });
    },
  },
}));

// Import the route AFTER the mocks so it binds to the stubs.
const { __streamingCreditTestHooks } = await import(
  "../v1/chat/completions/route"
);
const { handleStreamingRequest } = __streamingCreditTestHooks;

// --- global fetch mock (the direct upstream boundary) ------------------------
const realFetch = globalThis.fetch;
let fetchImpl:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;
const fetchMock = mock(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!fetchImpl)
      throw new ElizaError("fetchImpl not set", {
        code: "TEST_FIXTURE_UNCONFIGURED",
      });
    return fetchImpl(input, init);
  },
);

const ENV_KEYS = [
  "INFERENCE_PASSTHROUGH_STREAMING",
  "CEREBRAS_API_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module(
    "@/lib/services/ai-billing-records",
    () => aiBillingRecordsActual,
  );
  mock.module(
    "@/lib/services/team-credential-pool",
    () => teamCredentialPoolActual,
  );
  mock.module("@/lib/utils/logger", () => loggerActual);
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  generateText.mockClear();
  streamText.mockClear();
  billUsage.mockClear();
  recordUsageAnalytics.mockClear();
  aiBillingRecord.mockClear();
  poolRecordUse.mockClear();
  poolRecordProviderFailure.mockClear();
  errorCalls.length = 0;
  fetchMock.mockClear();
  generateTextImpl = null;
  streamTextImpl = null;
  fetchImpl = null;
  billUsageGate = null;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.INFERENCE_PASSTHROUGH_STREAMING = "true";
  process.env.CEREBRAS_API_KEY = "test-cerebras-key";
});

/** In-memory credit ledger, identical to the credit-leak suite's. */
function makeLedgerReservation(startBalance: number, hold: number) {
  let balance = startBalance - hold;
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

const QUALIFYING_REQUEST: Record<string, unknown> = {
  model: MODEL,
  messages: [{ role: "user", content: "hello" }],
  stream: true,
  stream_options: { include_usage: true },
};

function callStreaming(
  settleReservation: (actualCost: number) => Promise<unknown> | unknown,
  options: {
    model?: string;
    request?: unknown;
    estimatedInputTokens?: number;
    signal?: AbortSignal;
    effectiveMaxTokens?: number;
    pooledCredential?: unknown;
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    settleUnknown?: () => Promise<unknown> | unknown;
    providerDispatchTelemetry?: {
      capture(): void;
      emit(): void;
    };
    markProviderDispatched?: () => Promise<void>;
  } = {},
) {
  return handleStreamingRequest(
    options.model ?? MODEL,
    undefined,
    [{ role: "user", content: "hello" }] as never,
    (options.request ?? QUALIFYING_REQUEST) as never,
    { id: USER, organization_id: ORG },
    null,
    null,
    "idem-1",
    "req-1",
    null,
    Date.now(),
    options.signal,
    30_000,
    options.estimatedInputTokens ?? 1,
    settleReservation as never,
    (options.settleUnknown ?? (async () => null)) as never,
    undefined,
    {} as never,
    options.effectiveMaxTokens,
    {} as never,
    "cerebras" as never,
    (options.pooledCredential ?? null) as never,
    false,
    options.executionCtx,
    options.providerDispatchTelemetry,
    options.markProviderDispatched,
  );
}

const encoder = new TextEncoder();

function sseResponse(body: string, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream" } },
  );
}

// Deliberately quirky upstream bytes (vendor extension field, reasoning delta,
// upstream-chosen id) — the SDK re-encoder would normalize all of this away,
// so a strict equality on the response body proves zero re-encode.
const UPSTREAM_SSE =
  `data: {"id":"chatcmpl-upstream-1","object":"chat.completion.chunk","created":7,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel","reasoning":"thinking..."},"finish_reason":null}],"usage":null,"x_vendor":{"queue_ms":3}}\n\n` +
  `data: {"id":"chatcmpl-upstream-1","object":"chat.completion.chunk","created":7,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}],"usage":null}\n\n` +
  `data: {"id":"chatcmpl-upstream-1","object":"chat.completion.chunk","created":7,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n` +
  `data: {"id":"chatcmpl-upstream-1","object":"chat.completion.chunk","created":7,"model":"gpt-oss-120b","choices":[],"usage":{"prompt_tokens":72,"completion_tokens":60,"total_tokens":132,"prompt_tokens_details":{"cached_tokens":7}}}\n\n` +
  `data: [DONE]\n\n`;

const USAGE_TOKENS = { inputTokens: 72, outputTokens: 60, totalTokens: 132 };
const EXPECTED_COST =
  USAGE_TOKENS.inputTokens * INPUT_TOKEN_COST +
  USAGE_TOKENS.outputTokens * OUTPUT_TOKEN_COST;

describe("settled passthrough billing ledger continuity", () => {
  test.each([false, true])(
    "analytics unavailable still attempts one ledger write; ledger failure=%s",
    async (ledgerFails) => {
      const ledger = makeLedgerReservation(100, 0.9);
      const settle = createCreditReservationSettler(ledger.reservation);
      fetchImpl = async () => sseResponse(UPSTREAM_SSE);
      recordUsageAnalytics.mockImplementationOnce(async () => null);
      if (ledgerFails)
        aiBillingRecord.mockImplementationOnce(async () => {
          throw new ElizaError("ledger unavailable fixture", {
            code: "TEST_LEDGER_UNAVAILABLE",
          });
        });
      const res = await callStreaming(settle, { effectiveMaxTokens: 4096 });
      expect(await res.text()).toBe(UPSTREAM_SSE);
      expect(ledger.reconcileCalls).toBe(1);
      expect(ledger.actualCosts).toEqual([EXPECTED_COST]);
      expect(ledger.balance).toBeCloseTo(
        ledger.startBalance - EXPECTED_COST,
        10,
      );
      expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
      expect(aiBillingRecord).toHaveBeenCalledTimes(1);
      const calls = aiBillingRecord.mock.calls as unknown as Array<
        [Record<string, unknown>]
      >;
      expect(calls[0][0]).toMatchObject({
        usageRecord: null,
        idempotencyKey: "idem-1",
        context: {
          organizationId: ORG,
          userId: USER,
          requestId: "req-1",
          provider: "cerebras",
        },
      });
      expect(
        errorCalls.filter((e) => e.message.includes("audit record failed")),
      ).toHaveLength(ledgerFails ? 1 : 0);
    },
  );
});
