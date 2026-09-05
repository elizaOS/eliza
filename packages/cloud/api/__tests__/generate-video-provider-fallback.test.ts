/**
 * Exercises default video provider failover through the real Hono route and
 * provider registry with deterministic auth, billing, fal, and Atlas edges.
 * The suite verifies configuration filtering, terminal fallback, pending-job
 * preservation, actual-provider persistence, and single-settlement billing.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { subscriptionEntitlementsRepository } from "@/db/repositories/subscription-entitlements";

// These purchased-credit fixtures have no paid subscription. Keep the real
// funding selector and reservation path while supplying that repository state.
let entitlementLookup: ReturnType<typeof spyOn>;
beforeEach(() => {
  entitlementLookup = spyOn(
    subscriptionEntitlementsRepository,
    "find",
  ).mockResolvedValue(undefined);
});
afterEach(() => {
  entitlementLookup.mockRestore();
});

import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";

const falActual = require("@fal-ai/client") as typeof import("@fal-ai/client");
const { ApiError: FalApiError } = falActual;
const originalFetch = globalThis.fetch;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const FAL_MODEL = "fal-ai/veo3";
const ATLAS_MODEL = "vidu/q3-turbo/text-to-video";
const FAL_COST = 0.8;
const ATLAS_COST = 0.3;

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/content-safety", () => ({
  ...contentSafetyActual,
  contentSafetyService: {
    ...contentSafetyActual.contentSafetyService,
    assertSafeForPublicUse: async () => undefined,
  },
}));

const calculateVideoGenerationCostFromCatalog = mock(
  async ({ model }: { model: string }) => {
    const totalCost = model === FAL_MODEL ? FAL_COST : ATLAS_COST;
    return {
      totalCost,
      baseTotalCost: totalCost / 1.2,
      platformMarkup: totalCost - totalCost / 1.2,
    };
  },
);
mock.module("@/lib/services/ai-pricing", () => ({
  ...aiPricingActual,
  calculateVideoGenerationCostFromCatalog,
  getDefaultVideoBillingDimensions: (model: string) => ({
    durationSeconds: model === FAL_MODEL ? 8 : 5,
    dimensions:
      model === FAL_MODEL
        ? { audio: true }
        : { resolution: "720p", audio: false },
  }),
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

const fetchMock = mock(
  async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    throw new Error("Unexpected fetch in video fallback test");
  },
);
globalThis.fetch = Object.assign(fetchMock, {
  preconnect: originalFetch.preconnect,
});

const videoRoute = (await import("../v1/generate-video/route")).default;

afterAll(() => {
  globalThis.fetch = originalFetch;
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/services/content-safety", () => contentSafetyActual);
  mock.module("@/lib/services/ai-pricing", () => aiPricingActual);
  mock.module("@/lib/services/credits", () => creditsActual);
  mock.module("@/lib/services/generations", () => generationsActual);
  mock.module("@fal-ai/client", () => falActual);
});

type AppCtx = { set: (key: string, value: unknown) => void };

function makeLedgerReservation(
  startBalance: number,
  hold: number,
  reservationTransactionId = "11111111-1111-4111-8111-111111111111",
) {
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
      reservationTransactionId,
      reconcile: async (actualCost: number) => {
        reconcileCalls++;
        lastActual = actualCost;
        balance += hold - actualCost;
        return undefined;
      },
    },
  };
}

function atlasSuccess(url = "https://atlas.media/video.mp4") {
  return new Response(
    JSON.stringify({
      data: {
        id: "atlas-request-1",
        status: "completed",
        outputs: [url],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function post(
  env: Record<string, unknown>,
  body: Record<string, unknown> = { prompt: "a neon cat" },
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
  calculateVideoGenerationCostFromCatalog.mockClear();
  calculateVideoGenerationCostFromCatalog.mockImplementation(
    async ({ model }) => {
      const totalCost = model === FAL_MODEL ? FAL_COST : ATLAS_COST;
      return {
        totalCost,
        baseTotalCost: totalCost / 1.2,
        platformMarkup: totalCost - totalCost / 1.2,
      };
    },
  );
  reserve.mockReset();
  generationsCreate.mockReset();
  subscribe.mockReset();
  queueStatus.mockReset();
  queueResult.mockReset();
  fetchMock.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", "key-1");
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });
  generationsCreate.mockResolvedValue({ id: "generation-1" });
});

describe("generate-video — default provider fallback", () => {
  test("rejects an unconfigured default chain before pricing or credit work", async () => {
    const response = await post({});

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Video generation is not configured",
    });
    expect(calculateVideoGenerationCostFromCatalog).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses Atlas directly when fal credentials are absent", async () => {
    const ledger = makeLedgerReservation(100, ATLAS_COST);
    reserve.mockResolvedValue(ledger.reservation);
    fetchMock.mockResolvedValue(atlasSuccess());

    const response = await post({ ATLASCLOUD_API_KEY: "atlas-key" });

    expect(response.status).toBe(200);
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(ATLAS_COST, 10);
    expect(generationsCreate).toHaveBeenCalledTimes(1);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: ATLAS_MODEL,
      provider: "vidu",
      cost: String(ATLAS_COST),
      result: { billingSource: "atlascloud" },
      storage_url: "https://atlas.media/video.mp4",
    });
  });

  test("does not price an unused fallback when the primary succeeds", async () => {
    const ledger = makeLedgerReservation(100, FAL_COST);
    reserve.mockResolvedValue(ledger.reservation);
    calculateVideoGenerationCostFromCatalog.mockImplementation(
      async ({ model }) => {
        if (model === ATLAS_MODEL) throw new Error("Atlas pricing unavailable");
        return {
          totalCost: FAL_COST,
          baseTotalCost: FAL_COST / 1.2,
          platformMarkup: FAL_COST - FAL_COST / 1.2,
        };
      },
    );
    subscribe.mockResolvedValue({
      data: { video: { url: "https://fal.media/video.mp4" } },
      requestId: "fal-request-1",
    });

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(200);
    expect(calculateVideoGenerationCostFromCatalog).toHaveBeenCalledTimes(1);
    expect(
      calculateVideoGenerationCostFromCatalog.mock.calls[0]?.[0],
    ).toMatchObject({
      model: FAL_MODEL,
      billingSource: "fal",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.lastActual).toBeCloseTo(FAL_COST, 10);
  });

  test("keeps an explicit model request pinned to its provider", async () => {
    const response = await post(
      { ATLASCLOUD_API_KEY: "atlas-key" },
      { model: FAL_MODEL, prompt: "a neon cat" },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Fal video generation is not configured",
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses separate provider-priced reservations across a safe fallback", async () => {
    const falLedger = makeLedgerReservation(
      100,
      FAL_COST,
      "11111111-1111-4111-8111-111111111111",
    );
    const atlasLedger = makeLedgerReservation(
      100,
      ATLAS_COST,
      "22222222-2222-4222-8222-222222222222",
    );
    reserve
      .mockResolvedValueOnce(falLedger.reservation)
      .mockResolvedValueOnce(atlasLedger.reservation);
    subscribe.mockRejectedValue(
      new FalApiError({
        message: "invalid fal input",
        status: 422,
        body: undefined,
      }),
    );
    fetchMock.mockResolvedValue(atlasSuccess());

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(200);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls[0]?.[0]).toMatchObject({
      amount: FAL_COST,
      model: "veo3",
      provider: "fal",
      billingSource: "fal",
    });
    expect(reserve.mock.calls[1]?.[0]).toMatchObject({
      amount: ATLAS_COST,
      model: "q3-turbo",
      provider: "vidu",
      billingSource: "atlascloud",
    });
    expect(falLedger.reconcileCalls).toBe(1);
    expect(falLedger.lastActual).toBe(0);
    expect(atlasLedger.reconcileCalls).toBe(1);
    expect(atlasLedger.lastActual).toBeCloseTo(ATLAS_COST, 10);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: ATLAS_MODEL,
      provider: "vidu",
      result: { billingSource: "atlascloud" },
    });
  });

  test("releases each attempt when both providers reject terminally", async () => {
    const falLedger = makeLedgerReservation(
      100,
      FAL_COST,
      "11111111-1111-4111-8111-111111111111",
    );
    const atlasLedger = makeLedgerReservation(
      100,
      ATLAS_COST,
      "22222222-2222-4222-8222-222222222222",
    );
    reserve
      .mockResolvedValueOnce(falLedger.reservation)
      .mockResolvedValueOnce(atlasLedger.reservation);
    subscribe.mockRejectedValue(
      new FalApiError({
        message: "invalid fal input",
        status: 422,
        body: undefined,
      }),
    );
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid atlas input" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Video provider request failed",
      details: {
        provider: "vidu",
        model: ATLAS_MODEL,
        billingSource: "atlascloud",
      },
    });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(falLedger.reconcileCalls).toBe(1);
    expect(falLedger.lastActual).toBe(0);
    expect(atlasLedger.reconcileCalls).toBe(1);
    expect(atlasLedger.lastActual).toBe(0);
    expect(generationsCreate).not.toHaveBeenCalled();
  });

  test("falls back to Atlas when fal answers a 5xx on submit (no job issued)", async () => {
    const falLedger = makeLedgerReservation(
      100,
      FAL_COST,
      "11111111-1111-4111-8111-111111111111",
    );
    const atlasLedger = makeLedgerReservation(
      100,
      ATLAS_COST,
      "22222222-2222-4222-8222-222222222222",
    );
    reserve
      .mockResolvedValueOnce(falLedger.reservation)
      .mockResolvedValueOnce(atlasLedger.reservation);
    subscribe.mockRejectedValue(
      new FalApiError({
        message: "fal upstream unavailable",
        status: 503,
        body: undefined,
      }),
    );
    fetchMock.mockResolvedValue(atlasSuccess());

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(200);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(falLedger.reconcileCalls).toBe(1);
    expect(falLedger.lastActual).toBe(0);
    expect(atlasLedger.reconcileCalls).toBe(1);
    expect(atlasLedger.lastActual).toBeCloseTo(ATLAS_COST, 10);
    expect(generationsCreate).toHaveBeenCalledTimes(1);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: ATLAS_MODEL,
      provider: "vidu",
      status: "completed",
      result: { billingSource: "atlascloud" },
    });
  });

  test("does not dispatch Atlas when fal submission may have been accepted", async () => {
    const ledger = makeLedgerReservation(100, FAL_COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockRejectedValue(new Error("connection reset after upload"));

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      id: string;
      requestId: string;
    };
    expect(body).toMatchObject({
      success: false,
      status: "submission_unknown",
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      requestId: expect.stringMatching(/^generate-video:[^:]+:0$/),
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(FAL_COST, 10);
    // The charge is unverifiable, so a durable record must name the billing
    // request and reservation for support to locate and refund it.
    expect(generationsCreate).toHaveBeenCalledTimes(1);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      id: body.id,
      organization_id: ORG,
      user_id: USER,
      type: "video",
      model: FAL_MODEL,
      provider: "fal",
      status: "failed",
      error: "connection reset after upload",
      cost: String(FAL_COST),
      metadata: {
        settlement_marker: "video_submission_unknown_settlement_v1",
        settlement_state: "charged_unverified",
        billing_request_id: body.requestId,
        reservation_transaction_id: "11111111-1111-4111-8111-111111111111",
        billed_cost: FAL_COST,
        billing_source: "fal",
      },
    });
  });

  test("still settles conservatively when the submission-unknown record cannot be written", async () => {
    const ledger = makeLedgerReservation(100, FAL_COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockRejectedValue(new Error("connection reset after upload"));
    generationsCreate.mockRejectedValue(new Error("db unavailable"));

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "submission_unknown",
    });
    expect(generationsCreate).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(FAL_COST, 10);
  });

  test("does not fall back when fal may still complete upstream", async () => {
    const ledger = makeLedgerReservation(100, FAL_COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockImplementation(
      async (_model: string, options: Record<string, unknown>) => {
        (options.onEnqueue as (requestId: string) => void)("fal-pending-1");
        throw new Error("fal poll timed out");
      },
    );
    queueStatus.mockResolvedValue({ status: "IN_PROGRESS", logs: [] });

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(0);
    expect(generationsCreate).toHaveBeenCalledTimes(1);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: FAL_MODEL,
      provider: "fal",
      status: "pending",
      job_id: "fal-pending-1",
    });
  });

  test("does not refund or dispatch Atlas when a completed fal result probe is rate limited", async () => {
    const ledger = makeLedgerReservation(100, FAL_COST);
    reserve.mockResolvedValue(ledger.reservation);
    subscribe.mockImplementation(
      async (_model: string, options: Record<string, unknown>) => {
        (options.onEnqueue as (requestId: string) => void)("fal-completed-1");
        throw new Error("fal subscription lost");
      },
    );
    queueStatus.mockResolvedValue({ status: "COMPLETED" });
    queueResult.mockRejectedValue(
      new FalApiError({
        message: "rate limited",
        status: 429,
        body: undefined,
      }),
    );

    const response = await post({
      FAL_KEY: "fal-key",
      ATLASCLOUD_API_KEY: "atlas-key",
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      success: false,
      status: "pending",
      requestId: "fal-completed-1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(0);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: FAL_MODEL,
      provider: "fal",
      status: "pending",
      job_id: "fal-completed-1",
    });
  });

  test("pins Atlas billing and recovery identity when fallback polling is ambiguous", async () => {
    const falLedger = makeLedgerReservation(
      100,
      FAL_COST,
      "11111111-1111-4111-8111-111111111111",
    );
    const atlasLedger = makeLedgerReservation(
      100,
      ATLAS_COST,
      "22222222-2222-4222-8222-222222222222",
    );
    reserve
      .mockResolvedValueOnce(falLedger.reservation)
      .mockResolvedValueOnce(atlasLedger.reservation);
    subscribe.mockRejectedValue(
      new FalApiError({
        message: "invalid fal input",
        status: 422,
        body: undefined,
      }),
    );
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { id: "atlas-pending-1", status: "starting" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockRejectedValueOnce(new Error("atlas poll unavailable"));
    const runTimerImmediately = ((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(
      runTimerImmediately,
    );

    const response = await (async () => {
      try {
        return await post({
          FAL_KEY: "fal-key",
          ATLASCLOUD_API_KEY: "atlas-key",
        });
      } finally {
        timer.mockRestore();
      }
    })();

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      success: false,
      status: "pending",
      requestId: "atlas-pending-1",
    });
    expect(falLedger.reconcileCalls).toBe(1);
    expect(falLedger.lastActual).toBe(0);
    expect(atlasLedger.reconcileCalls).toBe(0);
    expect(generationsCreate).toHaveBeenCalledTimes(1);
    expect(generationsCreate.mock.calls[0]?.[0]).toMatchObject({
      model: ATLAS_MODEL,
      provider: "vidu",
      status: "pending",
      job_id: "atlas-pending-1",
      metadata: {
        reservation_transaction_id: "22222222-2222-4222-8222-222222222222",
        billed_cost: ATLAS_COST,
        billing_source: "atlascloud",
      },
    });
  });
});
