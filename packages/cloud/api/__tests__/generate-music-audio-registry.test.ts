import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import { registerAudioProvider } from "@/lib/providers/audio/registry";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import * as aiPricingDefsActual from "@/lib/services/ai-pricing-definitions";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const MODEL = "fal-ai/minimax-music/v2.6";
const COST = 0.25;

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

const calculateMusicGenerationCostFromCatalog = mock(async () => ({
  totalCost: COST,
}));
mock.module("@/lib/services/ai-pricing", () => ({
  ...aiPricingActual,
  calculateMusicGenerationCostFromCatalog,
}));

const getSupportedMusicModelDefinition = mock(
  (): ReturnType<
    typeof aiPricingDefsActual.getSupportedMusicModelDefinition
  > => ({
    modelId: MODEL,
    label: "MiniMax Music",
    provider: "fal",
    billingSource: "fal",
    pageUrl: "https://fal.ai/models/fal-ai/minimax-music/v2.6",
    defaultParameters: { durationSeconds: 60 },
  }),
);
mock.module("@/lib/services/ai-pricing-definitions", () => ({
  ...aiPricingDefsActual,
  getSupportedMusicModelDefinition,
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

const providerGenerate = mock();
registerAudioProvider({ billingSource: "fal", generate: providerGenerate });

const musicRoute = (await import("../v1/generate-music/route")).default;

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
});

type AppCtx = { set: (k: string, v: unknown) => void };

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
      },
    },
  };
}

function post(body: Record<string, unknown> = {}) {
  return musicRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, prompt: "ambient intro", ...body }),
    },
    { FAL_KEY: "fal-test-key" } as never,
  );
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  calculateMusicGenerationCostFromCatalog.mockClear();
  getSupportedMusicModelDefinition.mockReset();
  reserve.mockReset();
  generationsCreate.mockReset();
  providerGenerate.mockReset();

  getSupportedMusicModelDefinition.mockReturnValue({
    modelId: MODEL,
    label: "MiniMax Music",
    provider: "fal",
    billingSource: "fal",
    pageUrl: "https://fal.ai/models/fal-ai/minimax-music/v2.6",
    defaultParameters: { durationSeconds: 60 },
  });
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

describe("generate-music audio registry", () => {
  test("success uses registered provider and persists normalized audio", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    providerGenerate.mockResolvedValue({
      requestId: "audio-req",
      status: "completed",
      audio: {
        url: "https://cdn.test/out.mp3",
        file_size: 1234,
        content_type: "audio/mpeg",
      },
      raw: { provider: "fal" },
    });
    generationsCreate.mockResolvedValue({ id: "gen-1" });

    const res = await post({ durationSeconds: 30 });

    expect(res.status).toBe(200);
    expect(providerGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          model: MODEL,
          prompt: "ambient intro",
          durationSeconds: 30,
        }),
        user: expect.objectContaining({ id: USER, organization_id: ORG }),
      }),
    );
    expect(generationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: ORG,
        type: "music",
        storage_url: "https://cdn.test/out.mp3",
        file_size: BigInt(1234),
        mime_type: "audio/mpeg",
      }),
    );
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(COST);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
  });

  test("unsupported model validates before provider and credits", async () => {
    getSupportedMusicModelDefinition.mockReturnValue(undefined);

    const res = await post({ model: "fal-ai/stable-audio" });

    expect(res.status).toBe(400);
    expect(providerGenerate).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("provider failure before settle refunds the reservation", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    providerGenerate.mockRejectedValue(new Error("provider 503"));

    const res = await post();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(generationsCreate).not.toHaveBeenCalled();
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(0);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });

  test("post-settle persistence failure does not refund delivered audio", async () => {
    const ledger = makeLedgerReservation(100, COST);
    reserve.mockResolvedValue(ledger.reservation);
    providerGenerate.mockResolvedValue({
      requestId: "audio-req",
      audio: { url: "https://cdn.test/out.mp3", content_type: "audio/mpeg" },
    });
    generationsCreate.mockRejectedValue(new Error("db write failed"));

    const res = await post();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBe(COST);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - COST, 10);
  });
});
