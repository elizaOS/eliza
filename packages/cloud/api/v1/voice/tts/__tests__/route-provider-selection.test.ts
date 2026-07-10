/**
 * Route-level regression coverage for cloud TTS provider admission.
 *
 * These tests stop before synthesis so unsupported Kokoro ids can be proven to
 * fail without touching either upstream provider.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const assertSafeForPublicUse = mock(async () => undefined);
let allowKokoroFetch = false;
const fetchMock = mock<typeof fetch>(async () => {
  if (allowKokoroFetch) {
    return new Response(new Uint8Array([82, 73, 70, 70]), {
      headers: { "Content-Type": "audio/wav" },
    });
  }
  throw new Error("fetch must not be called for selection failures");
});
const realFetch = globalThis.fetch;

mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: class ApiError extends Error {
    statusCode = 500;
  },
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/db/repositories/user-voices", () => ({
  userVoicesRepository: {
    findByElevenLabsVoiceId: async () => null,
    incrementUsageCount: async () => undefined,
  },
}));

mock.module("@/lib/services/content-safety", () => ({
  contentSafetyService: { assertSafeForPublicUse },
}));

mock.module("@/lib/services/ai-pricing", () => ({
  calculateTTSCostFromCatalog: async () => ({
    totalCost: 0.001,
    baseTotalCost: 0.001,
    platformMarkup: 0,
  }),
}));

mock.module("@/lib/services/ai-billing", () => ({
  billFlatUsage: async () => ({
    totalCost: 0.001,
    baseTotalCost: 0.001,
    platformMarkup: 0,
  }),
}));

mock.module("@/lib/services/credits", () => {
  class InsufficientCreditsError extends Error {
    required = 0;
  }
  return {
    InsufficientCreditsError,
    creditsService: {
      reserve: async () => ({ reconcile: async () => undefined }),
    },
  };
});

mock.module("@/lib/services/elevenlabs", () => ({
  getElevenLabsService: () => ({
    textToSpeech: async () => new ReadableStream(),
  }),
}));

mock.module("@/lib/services/tts-first-line-cache", () => ({
  fingerprintCloudVoiceSettings: () => "fp-test",
  getCloudFirstLineCacheService: () => ({
    get: async () => null,
    has: async () => true,
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

let route: {
  default: {
    fetch: (
      request: Request,
      env?: Record<string, unknown>,
    ) => Promise<Response>;
  };
};

beforeAll(async () => {
  globalThis.fetch = fetchMock;
  route = (await import("../route")) as typeof route;
});

beforeEach(() => {
  allowKokoroFetch = false;
  fetchMock.mockClear();
  assertSafeForPublicUse.mockClear();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function postTts(body: unknown, env: Record<string, unknown> = {}) {
  return route.default.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("POST /api/v1/voice/tts provider selection", () => {
  test("uses Kokoro for the proxy-injected legacy default when configured", async () => {
    allowKokoroFetch = true;
    const response = await postTts(
      { text: "Hello.", voiceId: "EXAVITQu4vr4xnSDxMaL" },
      { KOKORO_TTS_URL: "https://kokoro.example.test" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("kokoro");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://kokoro.example.test/api/tts",
    );
    expect(assertSafeForPublicUse).toHaveBeenCalledTimes(1);
  });

  test("rejects unsupported Kokoro-shaped voice ids with clear 4xx and no upstream call", async () => {
    const response = await postTts(
      { text: "Hello.", voiceId: "af_not_a_voice" },
      { KOKORO_TTS_URL: "https://kokoro.example.test" },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("kokoro");
    const serverTiming = response.headers.get("Server-Timing") ?? "";
    expect(serverTiming).toContain("auth;dur=");
    expect(serverTiming).toContain("admission;dur=");
    expect(await response.json()).toEqual({
      error: "Unsupported Kokoro voice ID: af_not_a_voice",
      code: "unsupported_kokoro_voice",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
  });
});
