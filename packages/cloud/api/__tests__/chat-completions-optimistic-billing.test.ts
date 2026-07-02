/**
 * Route-level regression tests for the Tier-2 optimistic-billing DECISION in
 * POST /api/v1/chat/completions (#9899 / #10026, activated in prod by #10066).
 *
 * The optimistic-billing SERVICE layer (eligibility math, exactly-once settle,
 * sweep) is covered by `inference-billing-fast-path.test.ts`. What was NOT
 * covered is the ROUTE's orchestration of those functions — the part the prod
 * flag flip actually turns on:
 *
 *   gate (hot-path && flag && backstop-writable) → eligibility → write the
 *   durable backstop → only on a durable write take the optimistic path;
 *   otherwise fall back to the synchronous credit reserve.
 *
 * These tests drive the REAL `handleChatCompletionsPOST` through that decision
 * with the REAL `isOptimisticEligible` (the load-bearing predicate). Only the
 * env-gates, the gate-balance read, the backstop write, and the synchronous
 * reserve are mocked at the module boundary so we can (a) control the inputs and
 * (b) prove which billing path the route chose. The model call (`generateText`)
 * is stubbed to throw immediately AFTER the decision, so the route returns an
 * error response while the billing path has already been chosen — the spies are
 * the observation point, not the response.
 *
 * Invariants pinned (each has a POSITIVE assertion so an early bail before the
 * decision can't make a negative-only test pass):
 *   1. Eligible org → optimistic path: backstop written, synchronous reserve
 *      SKIPPED, optimistic settler wired.
 *   2. Balance below SAFE_BALANCE_THRESHOLD → synchronous reserve (no backstop).
 *   3. Backstop not writable (cache down) → synchronous reserve, never forwards
 *      on an un-recorded charge (#9899 free-inference hole).
 *   4. Flag OFF → synchronous reserve (default-safe).
 *   5. Non-durable backstop write → fall back to synchronous reserve (backstop
 *      attempted, optimistic settler NOT wired).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
// Spread the real modules: bun's `mock.module` replaces the registry entry
// process-wide, so dropping the other real exports would strand later test
// files importing from these modules; afterAll restores them.
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";
import * as fastPathActual from "@/lib/services/inference-billing-fast-path";
import * as modelCatalogActual from "@/lib/services/model-catalog";
import * as creditReservationActual from "@/lib/utils/credit-reservation";

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const CLIENT_REQUEST_ID = "req-optimistic-test";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// --- per-test knobs the mocks read by reference -----------------------------
let billingEnabled = true;
let backstopAvailable = true;
let gateBalanceUsd = 100;
let thresholdUsd = 5;
let backstopPersists = true;

// --- spies on the two terminal billing paths --------------------------------
const writePendingInferenceCharge = mock(async () => backstopPersists);
const reserveCredits = mock(async () => ({
  reservedAmount: 0.015,
  // not exercised — createCreditReservationSettler is stubbed to a no-op below
  reconcile: async () => null,
}));
const createOptimisticDebitSettler = mock(() => async () => null);
const createCreditReservationSettler = mock(() => async () => null);

// Auth: resolve straight to an authorized org user via the hot-path resolver so
// the org-credits branch (not app-credits) is taken and moderation is skipped.
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthContextActual,
  isInferenceHotPathCacheEnabled: () => true,
  resolveInferenceAuthContext: async () => ({
    kind: "authorized",
    ctx: { userId: USER, orgId: ORG, apiKeyId: API_KEY_ID },
  }),
}));

// Provider config: pretend a provider is configured; the model object is unused
// because the model call is stubbed.
mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasLanguageModelProviderConfigured: () => true,
  getLanguageModel: () => ({}) as never,
}));

// Cost: the optimistic gate computes an estimate; a tiny fixed cost keeps the
// org comfortably above it so eligibility turns only on the balance/threshold.
mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost: async () => ({
    totalCost: 0.01,
    inputCost: 0.005,
    outputCost: 0.005,
  }),
}));

// Reasoning-detection catalog read is best-effort; make it a no-op miss.
mock.module("@/lib/services/model-catalog", () => ({
  ...modelCatalogActual,
  getCachedGatewayModelById: async () => null,
}));

// Moderation: not under test.
mock.module("@/lib/services/content-moderation", () => ({
  ...contentModerationActual,
  contentModerationService: {
    ...contentModerationActual.contentModerationService,
    shouldBlockUser: async () => false,
    moderateInBackground: () => {},
  },
}));

// The component under test is the ROUTE's orchestration + the REAL
// isOptimisticEligible. Env-gates, the balance read, the backstop write and the
// optimistic settler factory are controlled/spied; isOptimisticEligible is left
// REAL (spread).
mock.module("@/lib/services/inference-billing-fast-path", () => ({
  ...fastPathActual,
  isOptimisticBillingEnabled: () => billingEnabled,
  isOptimisticBackstopAvailable: () => backstopAvailable,
  getGateBalanceUsd: async () => gateBalanceUsd,
  resolveSafeBalanceThresholdUsd: () => thresholdUsd,
  writePendingInferenceCharge,
  createOptimisticDebitSettler,
}));

// Synchronous reserve path — spied so we can prove it is the fallback.
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits,
}));

// Settler factory for the reserve path — stub to a no-op so the post-response
// settle in the catch block needs no ledger.
mock.module("@/lib/utils/credit-reservation", () => ({
  ...creditReservationActual,
  createCreditReservationSettler,
}));

// Stub the model call so the handler returns right after the billing decision.
mock.module("ai", () => ({
  ...aiActual,
  generateText: () => {
    throw new Error("model-call-stub");
  },
  streamText: () => {
    throw new Error("model-call-stub");
  },
}));

// Import the route AFTER the mocks so it binds to the stubs.
const { handleChatCompletionsPOST } = await import(
  "../v1/chat/completions/route"
);

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthContextActual,
  );
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/pricing", () => pricingActual);
  mock.module("@/lib/services/model-catalog", () => modelCatalogActual);
  mock.module(
    "@/lib/services/content-moderation",
    () => contentModerationActual,
  );
  mock.module(
    "@/lib/services/inference-billing-fast-path",
    () => fastPathActual,
  );
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module("@/lib/utils/credit-reservation", () => creditReservationActual);
});

function makeRequest(): Request {
  return new Request("https://api.test/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": CLIENT_REQUEST_ID,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });
}

async function drive(): Promise<void> {
  // The handler owns its try/catch and always returns a Response (the stubbed
  // model call makes it an error response); we only read the spies.
  await handleChatCompletionsPOST(makeRequest(), { skipOrgRateLimit: true });
}

describe("chat/completions optimistic-billing route decision (#9899/#10066)", () => {
  beforeEach(() => {
    billingEnabled = true;
    backstopAvailable = true;
    gateBalanceUsd = 100;
    thresholdUsd = 5;
    backstopPersists = true;
    writePendingInferenceCharge.mockClear();
    reserveCredits.mockClear();
    createOptimisticDebitSettler.mockClear();
    createCreditReservationSettler.mockClear();
  });

  test("eligible org takes the optimistic path: writes backstop, skips the synchronous reserve", async () => {
    await drive();
    // POSITIVE: the decision was reached and chose optimistic.
    expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
    expect(createOptimisticDebitSettler).toHaveBeenCalledTimes(1);
    // The synchronous reserve write (the latency we are removing) is skipped.
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  test("billing requestId is server-generated, not copied from x-request-id", async () => {
    await drive();

    const pendingCalls = writePendingInferenceCharge.mock
      .calls as unknown as Array<[{ requestId: string }, number]>;
    const settlerCalls = createOptimisticDebitSettler.mock
      .calls as unknown as Array<[{ requestId: string }]>;
    const pending = pendingCalls[0]?.[0];
    const settler = settlerCalls[0]?.[0];
    expect(pending).toBeDefined();
    expect(settler).toBeDefined();
    if (!pending || !settler) throw new Error("billing path was not reached");

    expect(pending.requestId).toMatch(UUID_RE);
    expect(pending.requestId).not.toBe(CLIENT_REQUEST_ID);
    expect(settler.requestId).toBe(pending.requestId);
  });

  test("balance below SAFE_BALANCE_THRESHOLD falls back to the synchronous reserve", async () => {
    gateBalanceUsd = 2; // < threshold 5 → not eligible
    await drive();
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(createOptimisticDebitSettler).not.toHaveBeenCalled();
  });

  test("backstop not writable (cache down) falls back to the synchronous reserve", async () => {
    backstopAvailable = false; // gate fails before eligibility
    await drive();
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  });

  test("optimistic billing flag OFF takes the synchronous reserve (default-safe)", async () => {
    billingEnabled = false;
    await drive();
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  });

  test("non-durable backstop write falls back to the synchronous reserve (never forwards un-recorded)", async () => {
    backstopPersists = false; // eligible + write attempted, but not durable
    await drive();
    // POSITIVE: the backstop write was attempted (decision chose optimistic)...
    expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
    // ...but a non-durable write must fall through to the synchronous reserve.
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(createOptimisticDebitSettler).not.toHaveBeenCalled();
  });
});
