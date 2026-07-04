/**
 * Poll-timeout settlement regression for POST /api/v1/generate-video (#11862).
 *
 * Before the fix, ANY provider failure fell into the catch's reconcile(0) full
 * refund — including a poll timeout with the upstream job still rendering. The
 * upstream then completes and bills the platform: the user gets a free refund
 * AND the platform pays for the render.
 *
 * The fix: a post-enqueue failure verifies the upstream terminal state. If the
 * job may still complete, the route throws VideoGenerationPendingError, keeps
 * the credit hold open (NO refund), persists a pending generation carrying the
 * settlement payload, and returns 202; the reconcile cron settles it later.
 * Verified terminal failures still refund immediately, and a job found
 * COMPLETED during the in-request probe is recovered and charged normally.
 *
 * The route handler and provider code under test are REAL; auth, pricing,
 * safety, credits, generations, and the fal client are mocked at the module
 * boundary (the reconcile ledger math is faithful to the real service).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import * as aiPricingDefsActual from "@/lib/services/ai-pricing-definitions";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";

const falActual = require("@fal-ai/client") as typeof import("@fal-ai/client");
const { ApiError } = falActual;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const MODEL = "fal-ai/veo3";
const COST = 0.5;
const RESERVATION_TX = "11111111-1111-4111-8111-111111111111";

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

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
const queueStatus = mock();
const queueResult = mock();
mock.module("@fal-ai/client", () => ({
  ...falActual,
  createFalClient: () => ({
    subscribe,
    queue: { status: queueStatus, result: queueResult },
  }),
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
      reservationTransactionId: RESERVATION_TX,
      reconcile: async (actualCost: number) => {
        reconcileCalls++;
        lastActual = actualCost;
        balance += hold - actualCost;
        return undefined;
      },
    },
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

function subscribeTimesOutAfterEnqueue() {
  subscribe.mockImplementation(
    async (_model: string, options: Record<string, unknown>) => {
      (options.onEnqueue as (id: string) => void)("fal-req-42");
      throw new Error("fal poll timed out");
    },
  );
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  reserve.mockReset();
  generationsCreate.mockReset();
  subscribe.mockReset();
  queueStatus.mockReset();
  queueResult.mockReset();

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

describe("generate-video — poll timeout with a live upstream job must NOT refund (#11862)", () => {
  test("hold stays open, pending generation persisted with the settlement payload, 202", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribeTimesOutAfterEnqueue();
    queueStatus.mockResolvedValue({ status: "IN_PROGRESS", logs: [] });
    generationsCreate.mockImplementation(
      async (data: Record<string, unknown>) => ({
        id: "gen-pending-1",
        ...data,
      }),
    );

    const res = await post();

    // Upstream may still complete and bill the platform — the pre-#11862
    // behavior (reconcile(0) full refund) is the money leak.
    expect(ledger.reconcileCalls).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.status).toBe("pending");
    expect(body.id).toBe("gen-pending-1");
    expect(body.requestId).toBe("fal-req-42");

    expect(generationsCreate).toHaveBeenCalledTimes(1);
    const created = generationsCreate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(created.status).toBe("pending");
    expect(created.job_id).toBe("fal-req-42");
    expect(created.organization_id).toBe(ORG);
    expect(created.metadata).toEqual({
      settlement_marker: "video_pending_settlement_v1",
      reservation_transaction_id: RESERVATION_TX,
      reserved_amount: COST,
      billed_cost: COST,
      billing_source: "fal",
    });
  });

  test("persisting the pending generation fails: STILL no refund (hold left for the sweep)", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribeTimesOutAfterEnqueue();
    queueStatus.mockResolvedValue({ status: "IN_QUEUE", queue_position: 1 });
    generationsCreate.mockRejectedValue(new Error("db write failed"));

    const res = await post();

    expect(res.status).toBeGreaterThanOrEqual(500);
    // Refunding here could refund a render that still completes upstream; the
    // stranded-reservation sweep settles the hold instead.
    expect(ledger.reconcileCalls).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
  });
});

describe("generate-video — in-request recovery when the job already completed", () => {
  test("probe finds COMPLETED: charged once at totalCost, generation completed, 200", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribeTimesOutAfterEnqueue();
    queueStatus.mockResolvedValue({ status: "COMPLETED" });
    queueResult.mockResolvedValue({
      data: {
        video: { url: "https://fal.media/late.mp4", content_type: "video/mp4" },
      },
      requestId: "fal-req-42",
    });
    generationsCreate.mockImplementation(
      async (data: Record<string, unknown>) => ({ id: "gen-ok-1", ...data }),
    );

    const res = await post();

    expect(res.status).toBe(200);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
    const created = generationsCreate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(created.status).toBe("completed");
    expect(created.storage_url).toBe("https://fal.media/late.mp4");
  });
});

describe("generate-video — verified terminal failures still refund exactly once", () => {
  test("upstream does not know the job (404): reconciled once to 0", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribeTimesOutAfterEnqueue();
    queueStatus.mockRejectedValue(
      new ApiError({ message: "Not found", status: 404, body: undefined }),
    );

    const res = await post();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(generationsCreate).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });

  test("pre-enqueue provider failure (no upstream job): reconciled once to 0", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockRejectedValue(new Error("fal upstream 503"));

    const res = await post();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(generationsCreate).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });
});
