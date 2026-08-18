/** Verifies the voice TTS request boundary with deterministic provider mocks. */
import { afterAll, describe, expect, mock, test } from "bun:test";

const assertSafeForPublicUse = mock(async () => undefined);
const markProviderDispatched = mock(async () => undefined);
const realFetch = globalThis.fetch;
const fetchMock = mock(
  async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const url = String(args[0]);
    if (url === "https://api.cartesia.ai/tts/bytes") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([73, 68, 51, 4]));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "audio/mpeg; codec=mp3" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  },
);
globalThis.fetch = fetchMock as unknown as typeof fetch;

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: null,
    admissionSnapshot: null,
  }),
  admitFlatGenerativeOperation: async () => ({
    reservation: undefined,
    settleUnknown: undefined,
    markProviderDispatched,
  }),
  asGenerativeCacheApiError: () => null,
  getGenerativeExecutionContext: () => undefined,
  getGenerativePricingCacheOptions: () => ({}),
}));

mock.module("@elizaos/shared/voice/first-sentence-snip", () => ({
  FIRST_SENTENCE_SNIP_VERSION: "1",
  firstSentenceSnip: (text: string) => ({
    raw: text,
    normalized: text,
    endOffset: text.length,
    wordCount: 1,
  }),
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));

mock.module("@/lib/services/content-safety", () => ({
  contentSafetyService: { assertSafeForPublicUse },
}));

mock.module("@/lib/services/ai-billing", () => ({
  billFlatUsage: async () => ({ totalCost: 0 }),
  reserveFlatUsageCredits: async () => undefined,
}));

mock.module("@/lib/services/ai-pricing", () => ({
  calculateTTSCostFromCatalog: async () => ({
    totalCost: 0.001,
    baseTotalCost: 0.001,
    platformMarkup: 0,
  }),
}));

mock.module("@/lib/services/credits", () => ({
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

mock.module("@/lib/services/elevenlabs", () => ({
  getElevenLabsService: () => ({
    textToSpeech: async () => {
      throw new Error("elevenlabs must not run in leftover-tax test");
    },
  }),
}));

mock.module("@/lib/services/tts-custom-voice-usage", () => ({
  recordCustomVoiceUsage: async () => undefined,
}));

mock.module("@/lib/services/tts-first-line-cache", () => ({
  fingerprintCloudVoiceSettings: () => "fp",
  getCloudFirstLineCacheService: () => ({
    get: async () => null,
    has: async () => false,
    put: async () => true,
  }),
  shouldBypassCloudFirstLineCache: () => true,
}));

mock.module("@/lib/services/usage", () => ({
  usageService: { create: async () => undefined },
}));

mock.module("@/lib/pricing-constants", () => ({
  CUSTOM_VOICE_TTS_MARKUP: 1.2,
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

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("POST /api/v1/voice/tts malformed JSON", () => {
  test("returns 400 instead of 500 and never admits synthesis", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
      { CARTESIA_API_KEY: "cartesia-key" },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
    expect(markProviderDispatched).not.toHaveBeenCalled();
  });

  test("canonical JSON still synthesizes speech", async () => {
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello from leftover-tax." }),
      }),
      { CARTESIA_API_KEY: "cartesia-key" },
    );
    expect(response.status).toBe(200);
    expect(markProviderDispatched).toHaveBeenCalled();
  });
});
