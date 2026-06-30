/**
 * Money-leak reproduction tests for POST /api/v1/embeddings.
 *
 * reserveCredits places a ~1.5x upfront hold that MUST be settled. On the
 * success path billUsage(reservation) reconciles it to actual usage. But when
 * the embedding provider throws (429 / 5xx) AFTER the reservation was taken and
 * BEFORE billing runs, the hold was previously never released — a permanent
 * over-debit. The fix releases it in the route's catch via the REAL idempotent
 * settler. These tests drive that settler against a ledger-backed reservation
 * and assert the org balance returns to its pre-request value, while the success
 * path still reconciles exactly once (never double-refunded).
 *
 * Everything is mocked at the module boundary EXCEPT the credit-reservation
 * settler and the reservation reconcile math, which are real.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { APICallError } from "ai";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";
import * as usageActual from "@/lib/services/usage";

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

const enforceOrgRateLimit = mock();
mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit,
}));

const resolveInferenceAuthContext = mock();
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthActual,
  resolveInferenceAuthContext,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasTextEmbeddingProviderConfigured: () => true,
  getTextEmbeddingModel: () => ({}) as never,
  resolveEmbeddingProviderSource: () => "openai",
  getAiProviderConfigurationError: () => "AI services are not configured",
}));

const reserveCredits = mock();
const billUsage = mock();
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits,
  billUsage,
}));

const usageCreate = mock();
mock.module("@/lib/services/usage", () => ({
  ...usageActual,
  usageService: { ...usageActual.usageService, create: usageCreate },
}));

const embed = mock();
const embedMany = mock();
mock.module("ai", () => ({
  ...aiActual,
  embed,
  embedMany,
}));

// Import the route AFTER the mocks. The route's createCreditReservationSettler
// import is REAL (not mocked) — it is the component under test.
const embeddingsRoute = (await import("../v1/embeddings/route")).default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthActual,
  );
  mock.module("@/lib/services/usage", () => usageActual);
  mock.module("ai", () => aiActual);
});

type AppCtx = { set: (k: string, v: unknown) => void };

/** Faithful credit ledger: reserve debits the hold; reconcile(0) refunds it. */
function makeLedgerReservation(startBalance: number, hold: number) {
  let balance = startBalance - hold;
  let reconcileCalls = 0;
  return {
    startBalance,
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
        return undefined;
      },
    },
  };
}

function makeApiCallError(statusCode: number) {
  return new APICallError({
    message: `provider returned ${statusCode}`,
    url: "https://provider.example/v1/embeddings",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

function makeExecutionCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(Promise.resolve(p));
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    scheduled,
  };
}

function post(body: unknown, ctx?: ExecutionContext) {
  return embeddingsRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    {},
    ctx,
  );
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  resolveInferenceAuthContext.mockReset();
  enforceOrgRateLimit.mockReset();
  reserveCredits.mockReset();
  billUsage.mockReset();
  usageCreate.mockReset();
  embed.mockReset();
  embedMany.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", API_KEY_ID);
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });
  resolveInferenceAuthContext.mockResolvedValue({
    kind: "slow_path",
    reason: "non_api_key",
  });
  enforceOrgRateLimit.mockResolvedValue(null);
  usageCreate.mockResolvedValue({ id: "usage-1" });
});

describe("embeddings — provider error releases the credit reservation", () => {
  for (const statusCode of [429, 503]) {
    test(`single-input provider ${statusCode}: hold released to 0, balance restored`, async () => {
      const ledger = makeLedgerReservation(100, 0.01);
      reserveCredits.mockResolvedValue(ledger.reservation);
      expect(ledger.balance).toBe(100 - 0.01); // hold debited up front
      embed.mockRejectedValue(makeApiCallError(statusCode));

      const { ctx, scheduled } = makeExecutionCtx();
      const res = await post(
        { model: "text-embedding-3-small", input: "hi" },
        ctx,
      );

      // Upstream provider failure is surfaced as the recoverable status, not a 401/403.
      expect(res.status).toBe(statusCode === 429 ? 429 : 503);
      // Billing never ran; the hold was released to 0 → balance back to pre-request.
      expect(billUsage).not.toHaveBeenCalled();
      expect(scheduled.length).toBe(0);
      expect(ledger.reconcileCalls).toBe(1);
      expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
    });
  }

  test("array-input provider 429: hold released to 0, balance restored", async () => {
    const ledger = makeLedgerReservation(100, 0.01);
    reserveCredits.mockResolvedValue(ledger.reservation);
    embedMany.mockRejectedValue(makeApiCallError(429));

    const { ctx } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: ["a", "b"] },
      ctx,
    );

    expect(res.status).toBe(429);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });
});

describe("embeddings — reserve() failure does not crash the release path", () => {
  test("a non-credits reserve() error returns 500 and does not attempt a release", async () => {
    // reserve() itself threw → settler is undefined → the catch guard must skip
    // the release (no crash) and surface the error.
    reserveCredits.mockRejectedValue(new Error("db down"));
    embed.mockResolvedValue({ embedding: [0.1], usage: { tokens: 5 } });

    const { ctx } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );

    expect(res.status).toBe(500);
    expect(embed).not.toHaveBeenCalled();
    expect(billUsage).not.toHaveBeenCalled();
  });
});

describe("embeddings — success settles to actual usage exactly once", () => {
  test("success path reconciles via billUsage once; the catch never double-refunds", async () => {
    const ledger = makeLedgerReservation(100, 0.01);
    const ACTUAL = 0.003;
    reserveCredits.mockResolvedValue(ledger.reservation);
    embed.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 5 } });
    // Model reality: billUsage reconciles the reservation to actual cost.
    billUsage.mockImplementation(async (_ctx, _usage) => {
      await ledger.reservation.reconcile(ACTUAL);
      return {
        inputCost: ACTUAL,
        outputCost: 0,
        totalCost: ACTUAL,
        baseInputCost: ACTUAL,
        baseOutputCost: 0,
        baseTotalCost: ACTUAL,
        platformMarkup: 0,
        inputTokens: 5,
        outputTokens: 0,
        totalTokens: 5,
        markupApplied: true,
      };
    });

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );
    expect(res.status).toBe(200);

    await Promise.all(scheduled);
    // Reconciled exactly once (by billUsage); the catch release never fired.
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - ACTUAL, 10);
  });
});

describe("embeddings — sync billUsage failure releases the upfront hold", () => {
  test("billUsage throwing before its reconcile (sync reserve) refunds the hold exactly once", async () => {
    const ledger = makeLedgerReservation(100, 0.01);
    reserveCredits.mockResolvedValue(ledger.reservation);
    embed.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 5 } });
    // billUsage throws BEFORE its internal reconcile (e.g. calculateCost or the
    // affiliate lookup fails) — reconcile never runs, so on the SYNC-reserve path
    // the upfront hold must be released by the route's inner catch (not leaked).
    billUsage.mockRejectedValue(new Error("billing pipeline error"));

    const { ctx, scheduled } = makeExecutionCtx();
    // The vectors were already returned; billing is deferred via waitUntil, so the
    // request still succeeds even though the deferred billing throws.
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );
    expect(res.status).toBe(200);

    await Promise.all(scheduled);
    // The inner catch released the hold exactly once (reconcile(0)); balance fully
    // restored — no permanent overcharge, and not double-refunded.
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });
});
