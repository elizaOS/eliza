/** Verifies the sound-effect generation request boundary with deterministic provider mocks. */
import { describe, expect, mock, test } from "bun:test";

const assertSafeForPublicUse = mock(async () => undefined);
const generateAudio = mock(async () => ({
  source: "hosted",
  url: "https://example.test/sfx.mp3",
  fileName: "sfx.mp3",
  fileSize: 10,
  contentType: "audio/mpeg",
  requestId: "req-sfx",
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
  billFlatUsage: async () => ({ totalCost: 0.1 }),
}));

mock.module("@/lib/services/ai-pricing", () => ({
  calculateSfxGenerationCostFromCatalog: async () => ({
    totalCost: 0.1,
    baseTotalCost: 0.1,
    platformMarkup: 0,
  }),
}));

mock.module("@/lib/services/credits", () => ({
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

mock.module("@/lib/services/generations", () => ({
  generationsService: { create: async () => ({ id: "gen-sfx" }) },
}));

mock.module("@/lib/providers/audio/registry", () => ({
  getAudioProvider: () => ({ generate: generateAudio }),
}));

mock.module("@/lib/storage/r2-public-object", () => ({
  putPublicObject: async () => ({ url: "https://example.test/s.mp3" }),
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
  model: "elevenlabs/sound_effects_v1",
  prompt: "glass clink",
};

describe("POST /api/v1/generate-sfx malformed JSON", () => {
  test("returns 400 instead of 500 and never admits generation", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
      { ELEVENLABS_API_KEY: "el-test-key" },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
    expect(generateAudio).not.toHaveBeenCalled();
  });

  test("canonical JSON still generates sfx", async () => {
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      { ELEVENLABS_API_KEY: "el-test-key" },
    );
    expect(response.status).toBe(200);
    expect(generateAudio).toHaveBeenCalled();
  });
});
