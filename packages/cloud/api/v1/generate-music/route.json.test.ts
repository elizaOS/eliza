/** Verifies the music generation request boundary with deterministic provider mocks. */
import { describe, expect, mock, test } from "bun:test";

const assertSafeForPublicUse = mock(async () => undefined);
const generateAudio = mock(async () => ({
  source: "hosted",
  url: "https://v3b.fal.media/files/music-output.mp3",
  fileName: "music-output.mp3",
  fileSize: 1234,
  contentType: "audio/mpeg",
  requestId: "req-music",
  status: "completed",
  raw: {},
}));
const markProviderDispatched = mock(async () => undefined);

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: null,
    admissionSnapshot: null,
  }),
  admitFlatGenerativeOperation: async () => ({
    reservation: { reconcile: async () => undefined },
    settle: async () => undefined,
    settleUnknown: async () => undefined,
    markProviderDispatched,
  }),
  asGenerativeCacheApiError: () => null,
  getGenerativeExecutionContext: () => undefined,
  getGenerativePricingCacheOptions: () => ({}),
}));

mock.module("@/lib/services/content-safety", () => ({
  contentSafetyService: { assertSafeForPublicUse },
}));

mock.module("@/lib/services/ai-billing", () => ({
  billFlatUsage: async () => ({ totalCost: 0.18 }),
}));

mock.module("@/lib/services/ai-pricing", () => ({
  calculateMusicGenerationCostFromCatalog: async () => ({
    totalCost: 0.18,
    baseTotalCost: 0.15,
    platformMarkup: 0.03,
  }),
}));

mock.module("@/lib/services/credits", () => ({
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

mock.module("@/lib/services/generations", () => ({
  generationsService: { create: async () => ({ id: "gen-music" }) },
}));

mock.module("@/lib/providers/audio/registry", () => ({
  getAudioProvider: () => ({ generate: generateAudio }),
}));

mock.module("@/lib/storage/r2-public-object", () => ({
  putPublicObject: async () => ({ url: "https://example.test/m.mp3" }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const { default: app } = await import("./route");

const validBody = {
  model: "fal-ai/minimax-music/v2.6",
  prompt: "city pop verification",
};

describe("POST /api/v1/generate-music malformed JSON", () => {
  test("returns 400 instead of 500 and never admits generation", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
      { FAL_KEY: "fal-test-key" },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
    expect(generateAudio).not.toHaveBeenCalled();
  });

  test("canonical JSON still generates music", async () => {
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      { FAL_KEY: "fal-test-key" },
    );
    expect(response.status).toBe(200);
    expect(generateAudio).toHaveBeenCalled();
  });
});
