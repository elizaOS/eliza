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
const reserveCredits = mock(async () => ({
  reconcile: async () => undefined,
}));
const billUsage = mock(async () => ({
  totalCost: 0.001,
  baseTotalCost: 0.001,
  platformMarkup: 0,
}));
const elevenLabsTextToSpeech = mock(
  async () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([73, 68, 51]));
        controller.close();
      },
    }),
);
let allowKokoroFetch = false;
let cachedVoiceResponse: {
  bytes: Uint8Array;
  byteSize: number;
  contentType: string;
  hitCount: number;
} | null = null;
const fetchMock = Object.assign(
  mock(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
    if (allowKokoroFetch) {
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "Content-Type": "audio/wav" },
      });
    }
    throw new Error("fetch must not be called for selection failures");
  }),
  { preconnect: () => undefined },
) satisfies typeof fetch;
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
  billFlatUsage: billUsage,
}));

mock.module("@/lib/services/credits", () => {
  class InsufficientCreditsError extends Error {
    required = 0;
  }
  return {
    InsufficientCreditsError,
    creditsService: { reserve: reserveCredits },
  };
});

mock.module("@/lib/services/elevenlabs", () => ({
  getElevenLabsService: () => ({ textToSpeech: elevenLabsTextToSpeech }),
}));

mock.module("@/lib/services/tts-first-line-cache", () => ({
  fingerprintCloudVoiceSettings: () => "fp-test",
  getCloudFirstLineCacheService: () => ({
    get: async () => cachedVoiceResponse,
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
  cachedVoiceResponse = null;
  fetchMock.mockClear();
  assertSafeForPublicUse.mockClear();
  reserveCredits.mockClear();
  billUsage.mockClear();
  elevenLabsTextToSpeech.mockClear();
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

  test("serves a configured Kokoro cache hit with provider timing headers", async () => {
    cachedVoiceResponse = {
      bytes: new Uint8Array([82, 73, 70, 70]),
      byteSize: 4,
      contentType: "audio/wav",
      hitCount: 2,
    };

    const response = await postTts(
      { text: "Hello.", voiceId: "af_heart" },
      {
        KOKORO_TTS_URL: "https://kokoro.example.test",
        KOKORO_FIRST_LINE_CACHE: "1",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("kokoro");
    expect(response.headers.get("X-TTS-Cache")).toBe(
      "hit; kokoro; first-sentence",
    );
    expect(response.headers.get("Server-Timing")).toContain("synthesis;dur=");
    expect(await response.arrayBuffer()).toEqual(
      new Uint8Array([82, 73, 70, 70]).buffer,
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
    const body = (await response.json()) as {
      error: string;
      code: string;
    };
    expect(body).toEqual({
      error: "Unsupported Kokoro voice ID: af_not_a_voice",
      code: "unsupported_kokoro_voice",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
  });

  test("fails a Kokoro voice fast when the provider is unconfigured", async () => {
    const response = await postTts({ text: "Hello.", voiceId: "af_heart" });

    expect(response.status).toBe(503);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("kokoro");
    expect(response.headers.get("Server-Timing")).toContain("admission;dur=");
    const body = (await response.json()) as {
      error: string;
      code: string;
    };
    expect(body).toEqual({
      error: "Kokoro TTS is not configured for this environment.",
      code: "kokoro_unconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
  });

  test("preserves ElevenLabs routing and observability for a custom voice", async () => {
    const response = await postTts({
      text: "Hello from a custom voice.",
      voiceId: "custom-elevenlabs-voice",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("elevenlabs");
    const serverTiming = response.headers.get("Server-Timing") ?? "";
    expect(serverTiming).toContain("auth;dur=");
    expect(serverTiming).toContain("admission;dur=");
    expect(serverTiming).toContain("synthesis;dur=");
    expect(await response.arrayBuffer()).toEqual(
      new Uint8Array([73, 68, 51]).buffer,
    );
    expect(elevenLabsTextToSpeech).toHaveBeenCalledTimes(1);
    expect(elevenLabsTextToSpeech).toHaveBeenCalledWith({
      text: "Hello from a custom voice.",
      voiceId: "custom-elevenlabs-voice",
      modelId: undefined,
    });
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
