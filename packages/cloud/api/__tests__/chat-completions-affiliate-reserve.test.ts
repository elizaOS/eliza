/**
 * Guard tests for #12749 — /v1/chat/completions must fail closed (402) when a
 * caller can afford the base cost but NOT base + affiliate markup.
 *
 * #11976 threaded `affiliateCode` into the synchronous reserveCredits
 * (`estimatedCostMultiplier = 1 + markup`), so the upfront hold covers the
 * attacker-set markup (up to 1000%) and the later cashable affiliate credit is
 * always backed by money the platform actually collected. #12749 routes every
 * affiliate-marked request onto that synchronous reserve (the optimistic
 * fast paths are gated off by `affiliateCode === null`); these tests pin the
 * money invariant of that fallback on THIS route: the marked-up hold is
 * attempted and, when the balance can't cover it, the request is 402'd before
 * the model call — no settle, no mint.
 *
 * They drive the REAL `handleChatCompletionsPOST` + the REAL reserveCredits
 * from ai-billing (affiliate resolution and multiplier math run for real).
 * Only the deep boundaries are stubbed: auth, provider config, pricing's
 * calculateCost (deterministic $0.10 base), the affiliate lookup, the credits
 * ledger reserve (reproducing credits.ts's hold arithmetic + fail-closed
 * InsufficientCreditsError), the earnings writer, and the model call (which
 * throws, because the 402 gate — not the settle — is the observation point).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as affiliatesActual from "@/db/repositories/affiliates";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as creditsActual from "@/lib/services/credits";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";
import * as modelCatalogActual from "@/lib/services/model-catalog";
import * as redeemableEarningsActual from "@/lib/services/redeemable-earnings";
import * as teamPoolActual from "@/lib/services/team-credential-pool";
import * as creditReservationActual from "@/lib/utils/credit-reservation";

process.env.DATABASE_URL ||= "pglite://memory";
// Force the synchronous-reserve path (the one #12749 falls back to): optimistic
// billing off, no DB ledger.
process.env.INFERENCE_OPTIMISTIC_BILLING = "";
process.env.INFERENCE_BILLING_LEDGER = "";
delete process.env.CREDIT_COST_BUFFER; // default 1.5, mirrored by the stub

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const AFFILIATE_USER = "00000000-0000-4000-8000-00000000aff1";

const BASE_COST = 0.1; // deterministic base+platform cost from calculateCost
const COST_BUFFER = 1.5; // credits.ts default (CREDIT_COST_BUFFER unset)

// NOTE: this file needs the REAL ai-billing (reserveCredits →
// resolveBillableAffiliate → multiplier math) — it is the code under test
// together with the route's reserve context. It therefore must run in its own
// process (the canonical `test/run-unit-isolated.mjs` lane does this): bun's
// top-level mock.module is process-global with no working per-file restore, so
// a sibling suite that mocks reserveCredits (chat-completions-optimistic-
// billing.test.ts) would leak its stub into this file if both shared a process.

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

// Deterministic pricing so the affiliate math is exact.
mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost: async () => ({
    totalCost: BASE_COST,
    inputCost: BASE_COST,
    outputCost: 0,
  }),
}));

// Pooled-credential selection is not under test — and it is the ONLY real DB
// query on this path. Stubbing it keeps PGlite from ever booting: under bun
// test, PGlite's Emscripten runtime sets process.exitCode = 99 as a side
// effect of initializing, which makes the file's process exit non-zero even
// with every test green (the isolated runner then reports it FAILED).
mock.module("@/lib/services/team-credential-pool", () => ({
  ...teamPoolActual,
  getTeamPoolRegistry: () => ({
    selectCredential: async () => null,
    recordUse: async () => undefined,
    recordProviderFailure: async () => undefined,
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

// Affiliate lookup: attacker-set 1000% markup owned by AFFILIATE_USER.
const getAffiliateCodeByCode = mock(async () => ({
  id: "aff-code-1",
  user_id: AFFILIATE_USER,
  markup_percent: "1000",
  is_active: true,
}));
mock.module("@/db/repositories/affiliates", () => ({
  ...affiliatesActual,
  affiliatesRepository: new Proxy(affiliatesActual.affiliatesRepository, {
    get: (target, prop, receiver) =>
      prop === "getAffiliateCodeByCode"
        ? getAffiliateCodeByCode
        : Reflect.get(target, prop, receiver),
  }),
}));

// Credits ledger: reserve stub reproducing the REAL hold arithmetic
// (credits.ts reserve(): estimatedCost × estimatedCostMultiplier, buffered by
// COST_BUFFER, thrown InsufficientCreditsError when the org balance can't
// cover the hold) so the hold AND the 402 gate are faithful to prod.
let orgBalanceUsd = Number.POSITIVE_INFINITY;
const reconcile = mock(async (_actualCost: number) => undefined);
const reserve = mock(
  async (
    params: { estimatedCostMultiplier?: number } & Record<string, unknown>,
  ) => {
    const multiplier = params.estimatedCostMultiplier ?? 1;
    const hold = BASE_COST * multiplier * COST_BUFFER;
    if (hold > orgBalanceUsd) {
      // The REAL class the route's instanceof checks against (credits.ts,
      // re-exported by ai-billing) — mirrors credits.ts reserve() fail-closed.
      throw new creditsActual.InsufficientCreditsError(hold, orgBalanceUsd);
    }
    return {
      reservedAmount: hold,
      reservationTransactionId: "reservation-1",
      reconcile,
    };
  },
);
mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  creditsService: new Proxy(creditsActual.creditsService, {
    get: (target, prop, receiver) =>
      prop === "reserve" ? reserve : Reflect.get(target, prop, receiver),
  }),
}));

// The cashable write that must never happen on a 402'd request.
const addEarnings = mock(async (_params: Record<string, unknown>) => ({
  ledgerId: "ledger-1",
}));
mock.module("@/lib/services/redeemable-earnings", () => ({
  ...redeemableEarningsActual,
  redeemableEarningsService: new Proxy(
    redeemableEarningsActual.redeemableEarningsService,
    {
      get: (target, prop, receiver) =>
        prop === "addEarnings"
          ? addEarnings
          : Reflect.get(target, prop, receiver),
    },
  ),
}));

// Settler factory for the reserve path — stub to a no-op so the post-response
// settle in the catch block needs no ledger (the 402 gate is the observation
// point, not the settle).
const createCreditReservationSettler = mock(() => async () => null);
mock.module("@/lib/utils/credit-reservation", () => ({
  ...creditReservationActual,
  createCreditReservationSettler,
}));

// Stub the model call so the positive control returns right after the billing
// decision; the attack request must 402 BEFORE ever reaching it.
const generateText = mock(() => {
  throw new Error("model-call-stub");
});
mock.module("ai", () => ({
  ...aiActual,
  generateText,
  streamText: () => {
    throw new Error("model-call-stub");
  },
}));

// Import the route AFTER the mocks. ai-billing (reserveCredits,
// resolveBillableAffiliate, the multiplier math) is REAL — it is the code under
// test together with the route's reserve context.
const { handleChatCompletionsPOST } = await import(
  "../v1/chat/completions/route"
);

afterAll(() => {
  // Leave the knob fail-safe BEFORE restoring the modules: bun's mock.module
  // can leave already-evaluated importers bound to these closures, which read
  // the knob by reference (see embeddings-optimistic-billing.test.ts).
  orgBalanceUsd = Number.POSITIVE_INFINITY;
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
  mock.module("@/db/repositories/affiliates", () => affiliatesActual);
  mock.module("@/lib/services/credits", () => creditsActual);
  mock.module(
    "@/lib/services/redeemable-earnings",
    () => redeemableEarningsActual,
  );
  mock.module("@/lib/services/team-credential-pool", () => teamPoolActual);
  mock.module("@/lib/utils/credit-reservation", () => creditReservationActual);
  mock.module("ai", () => aiActual);
});

function makeRequest(affiliateCode?: string): Request {
  return new Request("https://api.test/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(affiliateCode ? { "X-Affiliate-Code": affiliateCode } : {}),
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });
}

beforeEach(() => {
  orgBalanceUsd = Number.POSITIVE_INFINITY;
  getAffiliateCodeByCode.mockClear();
  reserve.mockClear();
  reconcile.mockClear();
  addEarnings.mockClear();
  createCreditReservationSettler.mockClear();
  generateText.mockClear();
});

// The first request through the handler pays a multi-second one-off init cost
// (PGlite boot via the TeamPoolRegistry lookup), so both tests get a generous
// timeout — a timed-out first test would leak its in-flight request into the
// second one's spy counts.
const TEST_TIMEOUT_MS = 30_000;

describe("POST /api/v1/chat/completions — affiliate markup is reserved upfront (#12749)", () => {
  test(
    "X-Affiliate-Code folds the 1000% markup into the synchronous hold",
    async () => {
      const res = await handleChatCompletionsPOST(makeRequest("PARTNER1000"), {
        skipOrgRateLimit: true,
      });
      // The stubbed model call makes this an error response — the reserve args
      // are the observation point, not the status.
      expect(res.status).not.toBe(402);

      expect(reserve).toHaveBeenCalledTimes(1);
      const reserveArg = reserve.mock.calls[0][0] as {
        organizationId: string;
        estimatedCostMultiplier?: number;
      };
      expect(reserveArg.organizationId).toBe(ORG);
      expect(reserveArg.estimatedCostMultiplier).toBeCloseTo(11, 6); // 1 + 1000%
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "caller who can afford base but NOT base+markup is 402'd upfront — no model call, no settle, no mint",
    async () => {
      // $0.20 covers the base hold ($0.10 × 1.5 = $0.15) but NOT the marked-up
      // hold ($0.10 × 11 × 1.5 = $1.65). Pre-#11976/#12749 this request would
      // proceed and settle a marked-up charge against a base-only hold while
      // minting the uncollectable delta as cashable earnings.
      orgBalanceUsd = 0.2;

      // Positive control: WITHOUT the affiliate header the same balance passes
      // the reserve gate (no multiplier on the hold).
      const controlRes = await handleChatCompletionsPOST(makeRequest(), {
        skipOrgRateLimit: true,
      });
      expect(controlRes.status).not.toBe(402);
      expect(reserve).toHaveBeenCalledTimes(1);
      const controlArg = reserve.mock.calls[0][0] as {
        estimatedCostMultiplier?: number;
      };
      expect(controlArg.estimatedCostMultiplier).toBeUndefined();

      reserve.mockClear();
      reconcile.mockClear();
      addEarnings.mockClear();
      generateText.mockClear();

      // The attack request: base affordable, base+markup not → fail-closed 402
      // BEFORE the model call, so nothing settles and nothing is minted.
      const res = await handleChatCompletionsPOST(makeRequest("PARTNER1000"), {
        skipOrgRateLimit: true,
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("insufficient_quota");

      expect(reserve).toHaveBeenCalledTimes(1); // the marked-up reserve attempt
      expect(generateText).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(addEarnings).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );
});
