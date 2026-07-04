/**
 * Regression coverage for MiniMax music duration/billing drift (#12067).
 *
 * MiniMax Music 2.6 on Fal is billed per audio and does not expose a duration
 * control in its current model schema. The route must not accept a client
 * duration that the provider ignores, and it must not store/bill a fake default
 * duration for that fixed-price model.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as audioRegistryActual from "@/lib/providers/audio/registry";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";

const ORG = "00000000-0000-4000-8000-000000001267";
const USER = "00000000-0000-4000-8000-000000001268";
const MINIMAX = "fal-ai/minimax-music/v2.6";
const ELEVENLABS = "elevenlabs/music_v1";

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

const calculateMusicGenerationCostFromCatalog = mock();
mock.module("@/lib/services/ai-pricing", () => ({
  ...aiPricingActual,
  calculateMusicGenerationCostFromCatalog,
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

const getAudioProvider = mock();
const generateAudio = mock();
mock.module("@/lib/providers/audio/registry", () => ({
  ...audioRegistryActual,
  getAudioProvider,
}));

const musicRoute = (await import("../v1/generate-music/route")).default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/services/content-safety", () => contentSafetyActual);
  mock.module("@/lib/services/ai-pricing", () => aiPricingActual);
  mock.module("@/lib/services/credits", () => creditsActual);
  mock.module("@/lib/services/generations", () => generationsActual);
  mock.module("@/lib/providers/audio/registry", () => audioRegistryActual);
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
        return undefined;
      },
    },
  };
}

function costFor(model: string, unit: "request" | "minute", totalCost: number) {
  return {
    totalCost,
    baseTotalCost: unit === "request" ? 0.15 : 0.25,
    platformMarkup: totalCost - (unit === "request" ? 0.15 : 0.25),
    matchedEntry: {
      billingSource: model.startsWith("elevenlabs/") ? "elevenlabs" : "fal",
      provider: model.startsWith("elevenlabs/") ? "elevenlabs" : "fal",
      model,
      productFamily: "music",
      chargeType: "generation",
      unit,
      unitPrice: unit === "request" ? 0.15 : 0.25,
      dimensions: {},
      sourceKind: unit === "request" ? "fal_model_page" : "elevenlabs_snapshot",
      sourceUrl: model.startsWith("elevenlabs/")
        ? "https://elevenlabs.io/docs/api-reference/music/compose"
        : "https://fal.ai/models/fal-ai/minimax-music/v2.6/api",
    },
  };
}

function post(
  body: Record<string, unknown>,
  env: Record<string, unknown> = { FAL_KEY: "fal-test-key" },
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
  calculateMusicGenerationCostFromCatalog.mockReset();
  reserve.mockReset();
  generationsCreate.mockReset();
  getAudioProvider.mockReset();
  generateAudio.mockReset();

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", "key-1");
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });

  generateAudio.mockResolvedValue({
    source: "hosted",
    url: "https://v3b.fal.media/files/music-output.mp3",
    fileName: "music-output.mp3",
    fileSize: 1234,
    contentType: "audio/mpeg",
    requestId: "req-music",
    status: "completed",
    raw: {
      audio: {
        url: "https://v3b.fal.media/files/music-output.mp3",
        content_type: "audio/mpeg",
      },
    },
  });
  getAudioProvider.mockImplementation((billingSource: string) => ({
    billingSource,
    generate: generateAudio,
  }));
});

describe("generate-music — MiniMax duration contract", () => {
  test("rejects explicit durationSeconds for MiniMax before provider or credit work", async () => {
    const res = await post({
      model: MINIMAX,
      prompt: "city pop verification",
      durationSeconds: 10,
    });

    expect(res.status).toBe(400);
    expect(calculateMusicGenerationCostFromCatalog).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(getAudioProvider).not.toHaveBeenCalled();

    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe("validation_error");
    expect(body.error).toContain("does not support durationSeconds");
  });

  test("MiniMax success is fixed-price and does not forward or store a fake duration", async () => {
    const cost = costFor(MINIMAX, "request", 0.18);
    const ledger = makeLedgerReservation(100, cost.totalCost);
    calculateMusicGenerationCostFromCatalog.mockResolvedValue(cost);
    reserve.mockResolvedValue(ledger.reservation);
    generationsCreate.mockResolvedValue({ id: "gen-music" });

    const res = await post({
      model: MINIMAX,
      prompt: "city pop verification",
      instrumental: true,
    });

    expect(res.status).toBe(200);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.lastActual).toBeCloseTo(0.18, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - 0.18, 10);

    const pricingParams = calculateMusicGenerationCostFromCatalog.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(pricingParams.durationSeconds).toBeUndefined();
    expect(pricingParams.dimensions).toEqual({ instrumental: true });

    const providerRequest = generateAudio.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(providerRequest.durationSeconds).toBeUndefined();

    const generationParams = generationsCreate.mock.calls[0]?.[0] as {
      parameters: Record<string, unknown>;
      dimensions: Record<string, unknown>;
      cost: string;
    };
    expect(generationParams.parameters.durationControl).toBe("unsupported");
    expect(generationParams.parameters.durationSeconds).toBeUndefined();
    expect(
      generationParams.parameters.requestedDurationSeconds,
    ).toBeUndefined();
    expect(generationParams.dimensions).toEqual({});
    expect(generationParams.cost).toBe("0.18");
  });

  test("supported music models forward the resolved default duration for billing and provider input", async () => {
    const cost = costFor(ELEVENLABS, "minute", 0.3);
    const ledger = makeLedgerReservation(100, cost.totalCost);
    const generate = mock(async (_req: Record<string, unknown>) => ({
      source: "hosted",
      url: "https://cdn.example.test/elevenlabs.mp3",
      fileName: "elevenlabs.mp3",
      fileSize: 2048,
      contentType: "audio/mpeg",
      requestId: "req-eleven",
      status: "completed",
      raw: {},
    }));
    calculateMusicGenerationCostFromCatalog.mockResolvedValue(cost);
    reserve.mockResolvedValue(ledger.reservation);
    generationsCreate.mockResolvedValue({ id: "gen-eleven" });
    getAudioProvider.mockReturnValue({ billingSource: "elevenlabs", generate });

    const res = await post(
      {
        model: ELEVENLABS,
        prompt: "piano verification",
      },
      { ELEVENLABS_API_KEY: "eleven-test-key" },
    );

    expect(res.status).toBe(200);
    const pricingParams = calculateMusicGenerationCostFromCatalog.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(pricingParams.durationSeconds).toBe(60);
    expect(pricingParams.dimensions).toEqual({ durationSeconds: 60 });

    const providerInput = generate.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(providerInput.durationSeconds).toBe(60);

    const generationParams = generationsCreate.mock.calls[0]?.[0] as {
      parameters: Record<string, unknown>;
      dimensions: Record<string, unknown>;
    };
    expect(generationParams.parameters.durationControl).toBe("supported");
    expect(generationParams.parameters.durationSeconds).toBe(60);
    expect(generationParams.dimensions).toEqual({ duration: 60 });
  });
});
