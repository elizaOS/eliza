/**
 * Money-leak regression for POST /api/v1/generate-video (#10278).
 *
 * The route reserves credits, settles them via reservation.reconcile(totalCost),
 * sets chargeSettled=true, THEN writes the generation row. reservation.reconcile
 * is non-idempotent (it refunds reservedAmount-actualCost from the closure-
 * captured hold). Before the fix, a post-settle failure (generationsService.create
 * throwing) fell into the catch's reconcile(0) and fully refunded an already-
 * settled, correct charge — a free video. The fix gates the catch refund on
 * `!chargeSettled`.
 *
 * These tests drive the real route handler with a faithful ledger-backed
 * reservation (the reconcile math is REAL) and assert:
 *  - post-settle DB failure: reconciled exactly once to totalCost, NOT refunded;
 *  - pre-settle provider failure: reconciled once to 0, balance fully restored;
 *  - clean success: reconciled once to totalCost.
 * Everything else is mocked at the module boundary.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import * as aiPricingDefsActual from "@/lib/services/ai-pricing-definitions";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";

const falActual = require("@fal-ai/client") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const MODEL = "fal-ai/veo3";
const COST = 0.5;

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

// rateLimit(preset) returns a Hono middleware; make it a transparent pass-through.
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { STRICT: { limit: 1, windowSeconds: 1 } },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/services/content-safety", () => ({
  ...contentSafetyActual,
  contentSafetyService: {
    ...contentSafetyActual.contentSafetyService,
    assertSafeForPublicUse: async () => undefined,
  },
}));

mock.module("@/lib/services/ai-pricing", () => ({
  ...aiPricingActual,
  calculateVideoGenerationCostFromCatalog: async () => ({ totalCost: COST }),
  getDefaultVideoBillingDimensions: () => ({
    durationSeconds: 8,
    dimensions: {},
  }),
}));

mock.module("@/lib/services/ai-pricing-definitions", () => ({
  ...aiPricingDefsActual,
  getSupportedVideoModelDefinition: (model: string) =>
    model === MODEL
      ? {
          provider: "fal",
          billingSource: "fal",
        }
      : undefined,
  SUPPORTED_VIDEO_MODEL_IDS: [MODEL],
}));

const reserve = mock();
mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  creditsService: { ...creditsActual.creditsService, reserve },
}));

const generationsCreate = mock();
mock.module("@/lib/services/generations", () => ({
  ...generationsActual,
  generationsService: {
    ...generationsActual.generationsService,
    create: generationsCreate,
  },
}));

const subscribe = mock();
mock.module("@fal-ai/client", () => ({
  ...falActual,
  createFalClient: () => ({ subscribe }),
}));

const videoRoute = (await import("../v1/generate-video/route")).default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/services/content-safety", () => contentSafetyActual);
  mock.module("@/lib/services/ai-pricing", () => aiPricingActual);
  mock.module(
    "@/lib/services/ai-pricing-definitions",
    () => aiPricingDefsActual,
  );
  mock.module("@/lib/services/credits", () => creditsActual);
  mock.module("@/lib/services/generations", () => generationsActual);
  mock.module("@fal-ai/client", () => falActual);
});

type AppCtx = { set: (k: string, v: unknown) => void };

/** Faithful credit ledger: reserve debits the hold; reconcile adjusts by hold-actual. */
function makeLedgerReservation(startBalance: number, hold: number) {
  let balance = startBalance - hold;
  let reconcileCalls = 0;
  let lastActual = Number.NaN;
  return {
    startBalance,
    get balance() {
      return balance;
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    get lastActual() {
      return lastActual;
    },
    reservation: {
      reservedAmount: hold,
      reconcile: async (actualCost: number) => {
        reconcileCalls++;
        lastActual = actualCost;
        balance += hold - actualCost;
        return undefined;
      },
    },
  };
}

const validResult = {
  requestId: "req-1",
  video: { url: "https://fal.media/out.mp4", content_type: "video/mp4" },
};

interface ErrorResponseBody {
  error?: string;
  details?: {
    supportedModels?: string[];
  };
}

function post(
  body: Record<string, unknown> = { model: MODEL, prompt: "a cat" },
  env: Record<string, unknown> = { FAL_KEY: "fal-test-key" },
) {
  return videoRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  reserve.mockReset();
  generationsCreate.mockReset();
  subscribe.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", "key-1");
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });
});

describe("generate-video — model/provider validation", () => {
  test("unsupported models are rejected before provider or credit work", async () => {
    const res = await post({ model: "not-a-video-model", prompt: "a cat" });

    expect(res.status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("Unsupported video model: not-a-video-model");
    expect(body.details?.supportedModels).toEqual([MODEL]);
  });

  test("missing FAL credentials are rejected before credit reservation", async () => {
    const res = await post({ model: MODEL, prompt: "a cat" }, {});

    expect(res.status).toBe(503);
    expect(reserve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    const body = (await res.json()) as ErrorResponseBody;
    expect(body.error).toBe("Fal video generation is not configured");
  });
});

describe("generate-video — post-settle failure must not refund (#10278)", () => {
  test("generationsService.create throws AFTER settle: reconciled once to totalCost, NOT refunded", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockResolvedValue(validResult);
    // Post-settle DB write fails — the regression trigger.
    generationsCreate.mockRejectedValue(new Error("db write failed"));

    const res = await post();

    // The request fails (the create threw)...
    expect(res.status).toBeGreaterThanOrEqual(500);
    // ...but the settled charge is NOT refunded: exactly one reconcile, to totalCost.
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(COST, 10);
    // Balance reflects the correct charge for a delivered video, not a free one.
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
  });
});

describe("generate-video — pre-settle failure still refunds", () => {
  test("fal.subscribe throws BEFORE settle: reconciled once to 0, balance restored", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockRejectedValue(new Error("fal upstream 503"));

    const res = await post();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(generationsCreate).not.toHaveBeenCalled();
    // Failure before settle → full refund (reconcile(0)).
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });
});

describe("generate-video — bills what it delivers (#11862 finding 2)", () => {
  test("when the client omits durationSeconds, the RESOLVED billing default is forwarded to the provider (not undefined)", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockResolvedValue(validResult);
    generationsCreate.mockResolvedValue({ id: "gen-1" });

    // No durationSeconds in the request → billing resolves it to the catalog
    // default (8, per the getDefaultVideoBillingDimensions mock above).
    const res = await post({ model: MODEL, prompt: "a cat" });

    expect(res.status).toBe(200);
    // The provider (fal) maps durationSeconds → input.duration. Before the fix
    // the raw request spread forwarded an undefined durationSeconds, so the
    // provider rendered its OWN default while we billed 8s → undercharge.
    expect(subscribe).toHaveBeenCalledTimes(1);
    const falInput = (
      subscribe.mock.calls[0]?.[1] as { input?: Record<string, unknown> }
    )?.input;
    expect(falInput?.duration).toBe(8);
    expect(falInput?.duration_seconds).toBe(8);
  });

  test("an explicit client durationSeconds is still forwarded unchanged", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockResolvedValue(validResult);
    generationsCreate.mockResolvedValue({ id: "gen-1" });

    const res = await post({
      model: MODEL,
      prompt: "a cat",
      durationSeconds: 5,
    });

    expect(res.status).toBe(200);
    const falInput = (
      subscribe.mock.calls[0]?.[1] as { input?: Record<string, unknown> }
    )?.input;
    expect(falInput?.duration).toBe(5);
  });
});

describe("generate-video — clean success settles once", () => {
  test("success path reconciles exactly once to totalCost", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockResolvedValue(validResult);
    generationsCreate.mockResolvedValue({ id: "gen-1" });

    const res = await post();

    expect(res.status).toBe(200);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
  });
});
