/**
 * Money-leak reproduction tests for POST /api/v1/chat/completions streaming.
 *
 * A credit reservation is a ~1.5x upfront hold that MUST be settled — either to
 * actual usage (success) or released to 0 (failure). When the AI SDK hits a
 * provider error at connect time (e.g. the cerebras 429 / 5xx the fail-fast path
 * surfaces) it fires NEITHER onFinish NOR onAbort — only onError. Before the fix
 * the hold was therefore never reconciled and the org was permanently
 * over-debited. These tests drive the REAL credit-reservation settler
 * (`createCreditReservationSettler`, not a mock) against a ledger-backed
 * reservation and assert:
 *
 *   1. On a provider 429, the streaming path releases the reservation to 0 — the
 *      org balance returns to its pre-request value.
 *   2. Same for a provider 5xx.
 *   3. The error path emits a terminal OpenAI-compatible error chunk + [DONE]
 *      (finding #11) so OpenAI-compatible clients can back off instead of seeing
 *      a silently-truncated 200 stream.
 *   4. The success path settles to actual usage exactly once, and a later
 *      stray onError cannot double-refund (idempotent settler).
 *
 * `streamText`, `getLanguageModel`, and the billing-price lookup are mocked at
 * the module boundary; the settler and reservation math are real.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { APICallError } from "ai";

// Spread the real module so other test files importing from "ai" are not
// stranded by the process-wide registry replacement; restore in afterAll.
const aiActual = require("ai") as Record<string, unknown>;

import { estimateTokens } from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as aiBillingRecordsActual from "@/lib/services/ai-billing-records";
import * as teamCredentialPoolActual from "@/lib/services/team-credential-pool";

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

// Import the route AFTER the mocks so it binds to the stubs.
const { __billingBranchTestHooks, __streamingCreditTestHooks } = await import(
  "../v1/chat/completions/route"
);
const { handleStreamingRequest } = __streamingCreditTestHooks;
const { shouldUsePooledNoopReservation } = __billingBranchTestHooks;

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

function makeApiCallError(statusCode: number) {
  return new APICallError({
    message: `provider returned ${statusCode}`,
    url: "https://provider.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

const MODEL = "openai/gpt-oss-120b";
const REQUEST = {
  model: MODEL,
  messages: [{ role: "user", content: "hello" }],
  stream: true,
} as never;

/** Invoke handleStreamingRequest with the test's settler and a fixed shape. */
function callStreaming(
  settleReservation: (actualCost: number) => Promise<unknown> | unknown,
  options: {
    affiliateCode?: string | null;
    estimatedInputTokens?: number;
    pooledCredential?: {
      organizationId: string;
      credentialId: string;
      providerId: "openai-api" | "anthropic-api" | "cerebras-api";
      apiKey: string;
      label: string;
    } | null;
    signal?: AbortSignal;
  } = {},
) {
  return handleStreamingRequest(
    MODEL,
    undefined,
    [{ role: "user", content: "hello" }] as never,
    REQUEST,
    { id: USER, organization_id: ORG },
    null,
    options.affiliateCode ?? null,
    "idem-1",
    "req-1",
    null,
    Date.now(),
    options.signal,
    30_000,
    options.estimatedInputTokens ?? 1,
    settleReservation as never,
    {} as never,
    undefined,
    {} as never,
    "gateway" as never,
    options.pooledCredential ?? null,
  );
}

beforeEach(() => {
  streamText.mockClear();
  billUsage.mockClear();
  recordUsageAnalytics.mockClear();
  aiBillingRecord.mockClear();
  poolRecordUse.mockClear();
  poolRecordProviderFailure.mockClear();
  streamTextImpl = null;
});

// Per-status OpenAI-compatible error.type the terminal chunk must carry —
// mirrors openAiErrorTypeForStatus in the route (429 is the ONLY status that
// may say rate_limit_error; a 400/503 mislabeled as rate limiting steers
// clients into pointless back-off retries).
const EXPECTED_ERROR_TYPE: Record<number, string> = {
  400: "invalid_request_error",
  429: "rate_limit_error",
  503: "service_unavailable",
};

describe("streaming chat — provider error releases the credit reservation", () => {
  for (const statusCode of [400, 429, 503]) {
    test(`provider ${statusCode}: reservation released to 0, balance restored, terminal error chunk emitted`, async () => {
      const ledger = makeLedgerReservation(100, 0.015);
      const settle = createCreditReservationSettler(ledger.reservation);
      // Sanity: the upfront hold has already debited the balance.
      expect(ledger.balance).toBe(100 - 0.015);

      const err = makeApiCallError(statusCode);
      let onErrorPromise: Promise<unknown> | undefined;
      streamTextImpl = (config) => {
        // SDK contract: a connect-time provider error fires onError ONLY.
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
      const body = await res.text();
      await onErrorPromise; // ensure the settle() inside onError completed

      // onFinish/onAbort never fired — only onError. The hold was released to 0.
      expect(ledger.reconcileCalls).toBe(1);
      expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);

      // Finding #11: a terminal OpenAI-shaped error chunk + [DONE] was emitted,
      // with the status-correct error.type (not a blanket rate_limit_error).
      expect(body).toContain('"error"');
      expect(body).toContain(`"type":"${EXPECTED_ERROR_TYPE[statusCode]}"`);
      expect(body).toContain(`"code":${statusCode}`);
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);

      // The error chunk parses as valid JSON with the expected shape.
      const dataLines = body
        .split("\n")
        .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
        .map((l) => JSON.parse(l.slice("data: ".length)));
      const errorChunk = dataLines.find((c) => "error" in c);
      expect(errorChunk).toBeDefined();
      expect(errorChunk.error.type).toBe(EXPECTED_ERROR_TYPE[statusCode]);
      expect(errorChunk.error.code).toBe(statusCode);
    });
  }

  test("fullStream error releases the reservation even when SDK onError is absent", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    expect(ledger.balance).toBe(100 - 0.015);

    const err = makeApiCallError(503);
    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield { type: "error", error: err };
      })(),
    });

    const res = await callStreaming(settle);
    const body = await res.text();

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
    expect(body).toContain('"error"');
    expect(body).toContain('"type":"service_unavailable"');
    expect(body).toContain('"code":503');
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("streaming chat — client abort settles delivered usage", () => {
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
  });

  test("request-signal abort after text deltas settles partial usage", async () => {
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
    expect(aiBillingRecord).toHaveBeenCalledTimes(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(expectedCost, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - expectedCost, 10);
  });

  test("AbortError-shaped provider failure without request abort refunds and does not bill", async () => {
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

    const res = await callStreaming(settle);
    const body = await res.text();

    expect(body).toContain(deliveredText);
    expect(body).toContain('"error"');
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([0]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
    expect(billUsage).not.toHaveBeenCalled();
    expect(recordUsageAnalytics).not.toHaveBeenCalled();
    expect(aiBillingRecord).not.toHaveBeenCalled();
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
    expect(aiBillingRecord).toHaveBeenCalledTimes(1);
    expect(ledger.actualCosts[0]).toBeGreaterThan(0);
  });
});

describe("streaming chat — success settles once, no double-refund", () => {
  test("pooled BYO key does not bypass monetized app billing reservation", () => {
    const pooledCredential = {
      organizationId: ORG,
      credentialId: "pooled-credential-1",
      providerId: "openai-api" as const,
      apiKey: "sk-pooled",
      label: "Team OpenAI key",
    };

    expect(
      shouldUsePooledNoopReservation({
        pooledCredential,
        useMonetizedAppBilling: false,
      }),
    ).toBe(true);
    expect(
      shouldUsePooledNoopReservation({
        pooledCredential,
        useMonetizedAppBilling: true,
      }),
    ).toBe(false);
  });

  test("pooled BYO-key success suppresses affiliate markup while recording pool use", async () => {
    const settle = mock(async () => null);
    let onFinishPromise: Promise<unknown> | undefined;

    streamTextImpl = (config) => {
      const onFinish = config.onFinish as
        | ((event: {
            text: string;
            usage: {
              inputTokens: number;
              outputTokens: number;
              totalTokens: number;
            };
          }) => Promise<unknown> | unknown)
        | undefined;

      return {
        fullStream: (async function* () {
          yield { type: "text-delta", id: "text-1", text: "pooled ok" };
          onFinishPromise = Promise.resolve(
            onFinish?.({
              text: "pooled ok",
              usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
            }),
          );
          yield { type: "finish", finishReason: "stop" };
        })(),
      };
    };

    const res = await callStreaming(settle, {
      affiliateCode: "SHOULD_NOT_PAY",
      pooledCredential: {
        organizationId: ORG,
        credentialId: "pooled-credential-1",
        providerId: "openai-api",
        apiKey: "sk-pooled",
        label: "Team OpenAI key",
      },
    });
    const body = await res.text();
    expect(onFinishPromise).toBeDefined();
    await onFinishPromise;

    expect(body).toContain("pooled ok");
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(
      (billUsage.mock.calls[0][0] as { affiliateCode?: string | null })
        .affiliateCode,
    ).toBe(null);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(poolRecordUse).toHaveBeenCalledWith({
      organizationId: ORG,
      credentialId: "pooled-credential-1",
      userId: USER,
    });
  });

  test("settler reconciles to actual cost exactly once; a stray onError cannot re-refund", async () => {
    const ledger = makeLedgerReservation(100, 0.015);
    const settle = createCreditReservationSettler(ledger.reservation);
    const ACTUAL = 0.004;

    // Drive the settler the way onFinish does (bill → settle to actual cost),
    // then simulate a stray late onError firing settle(0): the idempotent
    // first-call-wins settler must NOT reconcile a second time.
    const first = await settle(ACTUAL);
    const second = await settle(0); // would over-refund if not idempotent

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - ACTUAL, 10);
    // The cached settle result is returned for the second call.
    expect(second).toBe(first);
  });
});
