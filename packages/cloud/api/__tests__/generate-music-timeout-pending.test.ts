/**
 * Poll-timeout settlement regression for POST /api/v1/generate-music (#18436).
 *
 * Before the fix, ANY provider failure fell into the catch's reconcile(0) full
 * refund — including a poll timeout with the upstream job still rendering. The
 * upstream then completes and bills the platform: the user gets a free refund
 * AND the platform pays for the render.
 *
 * The fix: a post-enqueue timeout verifies the upstream terminal state. If the
 * job may still complete, the provider throws AudioGenerationPendingError, the
 * route keeps the credit hold open (NO refund), persists a pending generation
 * carrying the settlement payload, and returns 202; the reconcile cron settles
 * it later. Verified terminal failures still refund immediately, and a job
 * found COMPLETED during the in-request probe is recovered and charged normally.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import * as aiPricingDefsActual from "@/lib/services/ai-pricing-definitions";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const MODEL = "fal-ai/minimax-music/v2.6";
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
  calculateMusicGenerationCostFromCatalog: async () => ({ totalCost: COST }),
}));

mock.module("@/lib/services/ai-pricing-definitions", () => ({
  ...aiPricingDefsActual,
  getSupportedMusicModelDefinition: (model: string) =>
    model === MODEL
      ? {
          provider: "fal",
          billingSource: "fal",
          durationControl: "unsupported",
          defaultParameters: {},
        }
      : undefined,
  SUPPORTED_MUSIC_MODEL_IDS: [MODEL],
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

type MockState = {
  mode:
    | "timeout-pending"
    | "timeout-completed"
    | "timeout-failed"
    | "pre-enqueue-fail"
    | "status-5xx"
    | "result-5xx"
    | "success";
  submitCount: number;
  statusCount: number;
};

const mockState: MockState = {
  mode: "timeout-pending",
  submitCount: 0,
  statusCount: 0,
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "POST" && !url.includes("/status") && !url.endsWith("/requests/req-music")) {
    mockState.submitCount++;
    if (mockState.mode === "pre-enqueue-fail") {
      return Response.json({ detail: "fal upstream 503" }, { status: 503 });
    }
    return Response.json({
      request_id: "req-music",
      status_url: "https://queue.fal.run/fal-ai/minimax-music/v2.6/requests/req-music/status",
      response_url: "https://queue.fal.run/fal-ai/minimax-music/v2.6/requests/req-music",
    });
  }

  if (url.includes("/status")) {
    mockState.statusCount++;
    if (mockState.mode === "status-5xx") {
      return new Response("status unavailable", { status: 503 });
    }
    if (mockState.mode === "timeout-pending") {
      // Always IN_PROGRESS so the poll loop times out with a live request id.
      return Response.json({ status: "IN_PROGRESS" });
    }
    if (mockState.mode === "timeout-completed" || mockState.mode === "result-5xx") {
      // First status polls during runFalQueueJob stay pending; the post-timeout
      // probe (after FalQueueTimeoutError) reports COMPLETED.
      if (mockState.mode === "result-5xx") {
        return Response.json({ status: "COMPLETED" });
      }
      if (mockState.statusCount <= 2) {
        return Response.json({ status: "IN_PROGRESS" });
      }
      return Response.json({ status: "COMPLETED" });
    }
    if (mockState.mode === "timeout-failed") {
      if (mockState.statusCount <= 2) {
        return Response.json({ status: "IN_PROGRESS" });
      }
      return Response.json({ detail: "Not found" }, { status: 404 });
    }
    return Response.json({ status: "COMPLETED" });
  }

  if (url.includes("/requests/req-music")) {
    if (mockState.mode === "result-5xx") {
      return new Response("result unavailable", { status: 503 });
    }
    if (mockState.mode === "timeout-completed" || mockState.mode === "success") {
      return Response.json({
        audio: {
          url: "https://fal.media/late.mp3",
          content_type: "audio/mpeg",
          file_size: 4096,
        },
      });
    }
    return Response.json({ detail: "render failed" }, { status: 422 });
  }

  return Response.json({ detail: `unexpected fetch ${method} ${url}` }, { status: 500 });
}) as typeof fetch;

const musicRoute = (await import("../v1/generate-music/route")).default;

afterAll(() => {
  globalThis.fetch = originalFetch;
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
  body: Record<string, unknown> = { model: MODEL, prompt: "upbeat synthwave" },
  env: Record<string, unknown> = {
    FAL_KEY: "fal-test-key",
    // Tiny poll window so timeout paths finish quickly in CI.
    FAL_QUEUE_POLL_INTERVAL_MS: "5",
    FAL_QUEUE_TIMEOUT_MS: "40",
  },
) {
  return musicRoute.request(
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
  mockState.mode = "timeout-pending";
  mockState.submitCount = 0;
  mockState.statusCount = 0;

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

describe("generate-music — poll timeout with a live upstream job must NOT refund (#18436)", () => {
  test("hold stays open, pending generation persisted with the settlement payload, 202", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    mockState.mode = "timeout-pending";
    generationsCreate.mockImplementation(
      async (data: Record<string, unknown>) => ({
        id: "gen-pending-1",
        ...data,
      }),
    );

    const res = await post();

    expect(ledger.reconcileCalls).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.status).toBe("pending");
    expect(body.id).toEqual(expect.any(String));
    expect(body.requestId).toBe("req-music");

    expect(generationsCreate).toHaveBeenCalledTimes(1);
    const created = generationsCreate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(created.status).toBe("pending");
    expect(created.type).toBe("music");
    expect(created.id).toBe(body.id);
    expect(created.job_id).toBe("req-music");
    expect(created.organization_id).toBe(ORG);
    expect(created.metadata).toEqual({
      settlement_marker: "music_pending_settlement_v1",
      reservation_transaction_id: RESERVATION_TX,
      reserved_amount: COST,
      billed_cost: COST,
      billing_source: "fal",
    });
  });

  test("persisting the pending generation fails: non-pollable 503, hold retained, no generation id", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    mockState.mode = "timeout-pending";
    generationsCreate.mockRejectedValue(new Error("db write failed"));

    const res = await post();
    const body = (await res.json()) as Record<string, unknown>;

    // Must not advertise a pollable id that was never written (#18719 P1).
    expect(res.status).toBe(503);
    expect(body.status).toBe("untracked");
    expect(body.id).toBeUndefined();
    expect(body.requestId).toBe("req-music");
    expect(String(body.error)).toMatch(/Do not poll a generation id/i);
    // Upstream job may still complete — do not refund the hold.
    expect(ledger.reconcileCalls).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
  });
});

describe("generate-music — in-request recovery when the job already completed", () => {
  test("probe finds COMPLETED: charged once at totalCost, generation completed, 200", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    mockState.mode = "timeout-completed";
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
    expect(created.storage_url).toBe("https://fal.media/late.mp3");
  });
});

describe("generate-music — verified terminal failures still refund exactly once", () => {
  test("upstream does not know the job (404 after timeout): reconciled once to 0", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    mockState.mode = "timeout-failed";

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
    mockState.mode = "pre-enqueue-fail";

    const res = await post();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(generationsCreate).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });
});

describe("generate-music — post-enqueue transport failures must NOT refund (#18436 review)", () => {
  test("status 5xx after enqueue: 202 pending, hold open", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    mockState.mode = "status-5xx";
    generationsCreate.mockImplementation(
      async (data: Record<string, unknown>) => ({ id: "gen-s5", ...data }),
    );

    const res = await post();

    expect(res.status).toBe(202);
    expect(ledger.reconcileCalls).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("pending");
    expect(body.requestId).toBe("req-music");
  });

  test("result 5xx after COMPLETED status: 202 pending, hold open", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    mockState.mode = "result-5xx";
    generationsCreate.mockImplementation(
      async (data: Record<string, unknown>) => ({ id: "gen-r5", ...data }),
    );

    const res = await post();

    expect(res.status).toBe(202);
    expect(ledger.reconcileCalls).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
  });
});
