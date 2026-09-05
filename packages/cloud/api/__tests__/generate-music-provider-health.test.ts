/**
 * Regression coverage for the generate-music provider health gate (#18436).
 *
 * A hanging fal upstream used to hold every music request toward the 300s
 * ceiling. The route now feeds provider outcomes into a per provider+model
 * breaker and, while it is open, fails fast with a structured 503 BEFORE
 * content safety, pricing, or the credit hold — so no billable work is
 * admitted toward a known-degraded upstream. The breaker module is real;
 * auth, rate limiting, pricing, credits, and the audio provider are mocked.
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
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as audioRegistryActual from "@/lib/providers/audio/registry";
import * as aiPricingActual from "@/lib/services/ai-pricing";
import * as contentSafetyActual from "@/lib/services/content-safety";
import * as creditsActual from "@/lib/services/credits";
import * as generationsActual from "@/lib/services/generations";
import { resetGenerativeProviderHealthForTests } from "@/lib/services/generative-provider-health";

const ORG = "00000000-0000-4000-8000-000000001842";
const USER = "00000000-0000-4000-8000-000000001843";
const MINIMAX = "fal-ai/minimax-music/v2.6";

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

const COST = {
  totalCost: 0.18,
  baseTotalCost: 0.15,
  platformMarkup: 0.03,
  matchedEntry: {
    billingSource: "fal",
    provider: "fal",
    model: MINIMAX,
    productFamily: "music",
    chargeType: "generation",
    unit: "request",
    unitPrice: 0.15,
    dimensions: {},
    sourceKind: "fal_model_page",
    sourceUrl: "https://fal.ai/models/fal-ai/minimax-music/v2.6/api",
  },
};

function makeReservation() {
  const state = { reconcileCalls: 0, lastActual: Number.NaN };
  return {
    state,
    reservation: {
      reservedAmount: COST.totalCost,
      reconcile: async (actualCost: number) => {
        state.reconcileCalls++;
        state.lastActual = actualCost;
        return undefined;
      },
    },
  };
}

function post(body: Record<string, unknown>) {
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
    { FAL_KEY: "fal-test-key" },
  );
}

beforeEach(() => {
  resetGenerativeProviderHealthForTests();
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
  calculateMusicGenerationCostFromCatalog.mockResolvedValue(COST);
  getAudioProvider.mockImplementation((billingSource: string) => ({
    billingSource,
    generate: generateAudio,
  }));
});

async function failUpstreamOnce(message: string) {
  const { reservation } = makeReservation();
  reserve.mockResolvedValueOnce(reservation);
  generateAudio.mockRejectedValueOnce(new Error(message));
  const res = await post({ model: MINIMAX, prompt: "night drive synthwave" });
  expect(res.status).toBeGreaterThanOrEqual(500);
  return res;
}

describe("generate-music provider health gate", () => {
  test("three upstream timeouts open the gate; the next request fails fast before any credit hold", async () => {
    for (let i = 0; i < 3; i++) {
      await failUpstreamOnce(
        "fal queue job timed out after 300000ms (request r1)",
      );
    }
    expect(generateAudio).toHaveBeenCalledTimes(3);
    const reservesBefore = reserve.mock.calls.length;

    const res = await post({ model: MINIMAX, prompt: "lofi rain" });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    const body = (await res.json()) as {
      success: boolean;
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("service_unavailable");
    expect(body.error).toContain("backed up");
    expect(body.details?.provider).toBe("fal");
    expect(body.details?.model).toBe(MINIMAX);
    expect(body.details?.lastFailureKind).toBe("timeout");
    expect(typeof body.details?.retryAfterSeconds).toBe("number");

    // Fail-fast happened before admission and before the provider call.
    expect(reserve.mock.calls.length).toBe(reservesBefore);
    expect(generateAudio).toHaveBeenCalledTimes(3);
  });

  test("upstream 5xx failures also open the gate", async () => {
    for (let i = 0; i < 3; i++) {
      await failUpstreamOnce("fal queue submit failed (503)");
    }
    const res = await post({ model: MINIMAX, prompt: "lofi rain" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("service_unavailable");
    expect(generateAudio).toHaveBeenCalledTimes(3);
  });

  test("config errors (bad key 401) keep failing per request without tripping the gate", async () => {
    for (let i = 0; i < 3; i++) {
      await failUpstreamOnce("fal queue submit failed (401): invalid key");
    }
    const { reservation } = makeReservation();
    reserve.mockResolvedValueOnce(reservation);
    generateAudio.mockRejectedValueOnce(
      new Error("fal queue submit failed (401): invalid key"),
    );
    const res = await post({ model: MINIMAX, prompt: "lofi rain" });
    // Still reaches the provider — misconfiguration is not an outage.
    expect(generateAudio).toHaveBeenCalledTimes(4);
    expect(res.status).not.toBe(503);
  });

  test("a success closes the gate and later requests flow normally", async () => {
    await failUpstreamOnce("fal queue job timed out after 300000ms (r1)");
    await failUpstreamOnce("fal queue job timed out after 300000ms (r2)");

    const { reservation } = makeReservation();
    reserve.mockResolvedValueOnce(reservation);
    generationsCreate.mockResolvedValue({ id: "gen-music" });
    generateAudio.mockResolvedValueOnce({
      source: "hosted",
      url: "https://v3b.fal.media/files/music-output.mp3",
      fileName: "music-output.mp3",
      fileSize: 1234,
      contentType: "audio/mpeg",
      requestId: "req-music",
      status: "completed",
      raw: { audio: { url: "https://v3b.fal.media/files/music-output.mp3" } },
    });
    const ok = await post({ model: MINIMAX, prompt: "sunrise piano" });
    expect(ok.status).toBe(200);

    // Two fresh strikes after the success must not open the gate (streak reset).
    await failUpstreamOnce("fal queue job timed out after 300000ms (r3)");
    await failUpstreamOnce("fal queue job timed out after 300000ms (r4)");
    const { reservation: r2 } = makeReservation();
    reserve.mockResolvedValueOnce(r2);
    generateAudio.mockResolvedValueOnce({
      source: "hosted",
      url: "https://v3b.fal.media/files/music-output-2.mp3",
      contentType: "audio/mpeg",
      requestId: "req-music-2",
      status: "completed",
      raw: { audio: { url: "https://v3b.fal.media/files/music-2.mp3" } },
    });
    const stillOpen = await post({ model: MINIMAX, prompt: "sunset piano" });
    expect(stillOpen.status).toBe(200);
  });

  test("an ambiguous timeout retains the admitted charge while recording provider failure", async () => {
    const { state, reservation } = makeReservation();
    reserve.mockResolvedValueOnce(reservation);
    generateAudio.mockRejectedValueOnce(
      new Error("fal queue job timed out after 300000ms (request r9)"),
    );
    const res = await post({ model: MINIMAX, prompt: "storm ambience" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(state.reconcileCalls).toBe(1);
    expect(state.lastActual).toBe(COST.totalCost);
  });
});
