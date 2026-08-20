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
const reconcileReservation = mock(async (..._args: unknown[]) => undefined);
const payoutAwareReservation = {
  reservedAmount: 0.0012,
  reservationTransactionId: "reservation-1",
  affiliateAttribution: {
    affiliateCodeId: "00000000-0000-4000-8000-000000000010",
    affiliateUserId: "00000000-0000-4000-8000-000000000011",
    affiliateCode: "PARTNER",
    markupPercent: 0.2,
  },
  affiliatePayoutSourceId: "ai_billing:affiliate:voice-tts-test",
  reconcile: reconcileReservation,
};
const reserveCredits = mock(async () => payoutAwareReservation);
const billUsage = mock(async (..._args: unknown[]) => ({
  totalCost: 0.001,
  baseTotalCost: 0.001,
  platformMarkup: 0,
}));
const createUsage = mock(async (..._args: unknown[]) => undefined);
let elevenLabsBytes = new Uint8Array([73, 68, 51]);
let elevenLabsStreamFactory = () => {
  const bytes = elevenLabsBytes;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
};
const elevenLabsTextToSpeech = mock(async () => elevenLabsStreamFactory());
let allowKokoroFetch = false;
let cartesiaStatus = 200;
let cacheBypass = true;
let cachedVoiceResponse: {
  bytes: Uint8Array;
  byteSize: number;
  contentType: string;
  hitCount: number;
} | null = null;
const fetchMock = Object.assign(
  mock(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const url = String(args[0]);
    if (url === "https://api.cartesia.ai/tts/bytes") {
      if (cartesiaStatus !== 200) {
        return new Response("provider body must stay private", {
          status: cartesiaStatus,
        });
      }
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
const cacheGet = mock(async () => cachedVoiceResponse);
const cacheHas = mock(async () => true);
const cachePut = mock(async () => true);
class MockElizaError extends Error {
  code: string;
  context?: Record<string, unknown>;
  severity?: string;
  constructor(
    message: string,
    options: {
      code: string;
      context?: Record<string, unknown>;
      severity?: string;
    },
  ) {
    super(message);
    this.name = "ElizaError";
    this.code = options.code;
    this.context = options.context;
    this.severity = options.severity;
  }
}

mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: class ApiError extends Error {
    statusCode = 500;
  },
}));

mock.module("@elizaos/shared/voice/first-sentence-snip", () => ({
  FIRST_SENTENCE_SNIP_VERSION: "1",
  firstSentenceSnip: (text: string) => {
    const normalized = text.trim();
    if (!normalized) return null;
    return {
      raw: normalized,
      normalized,
      endOffset: text.trimEnd().length,
      wordCount: normalized.split(/\s+/u).length,
    };
  },
}));

mock.module("@elizaos/core", () => ({
  ElizaError: MockElizaError,
  isElizaError: (error: unknown) => error instanceof MockElizaError,
  redactSensitiveText: (text: string) => text,
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
  reserveFlatUsageCredits: reserveCredits,
}));

mock.module("@/lib/services/credits", () => {
  class InsufficientCreditsError extends Error {
    required = 0;
  }
  return {
    assertCreditRefundWithinReservation: () => {
      throw new Error("credit refund assertion is outside this test path");
    },
    assertValidCreditSettlementCosts: () => {
      throw new Error("credit settlement assertion is outside this test path");
    },
    InsufficientCreditsError,
  };
});

mock.module("@/lib/services/elevenlabs", () => ({
  getElevenLabsService: () => ({ textToSpeech: elevenLabsTextToSpeech }),
}));

mock.module("@/lib/services/tts-first-line-cache", () => ({
  fingerprintCloudVoiceSettings: () => "fp-test",
  getCloudFirstLineCacheService: () => ({
    get: cacheGet,
    has: cacheHas,
    put: cachePut,
  }),
  shouldBypassCloudFirstLineCache: () => cacheBypass,
}));

mock.module("@/lib/services/usage", () => ({
  usageService: { create: createUsage },
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
  cartesiaStatus = 200;
  cacheBypass = true;
  cachedVoiceResponse = null;
  elevenLabsBytes = new Uint8Array([73, 68, 51]);
  elevenLabsStreamFactory = () => {
    const bytes = elevenLabsBytes;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  };
  fetchMock.mockClear();
  assertSafeForPublicUse.mockClear();
  reserveCredits.mockClear();
  billUsage.mockClear();
  createUsage.mockClear();
  elevenLabsTextToSpeech.mockClear();
  reconcileReservation.mockClear();
  cacheGet.mockClear();
  cacheHas.mockClear();
  cachePut.mockClear();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function postTts(
  body: unknown,
  env: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return route.default.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("POST /api/v1/voice/tts provider selection", () => {
  test("uses Cartesia for an unpinned default when CARTESIA_API_KEY is configured", async () => {
    const response = await postTts(
      { text: "Hello from Cartesia." },
      {
        CARTESIA_API_KEY: "cartesia-key",
        CARTESIA_VOICE_ID: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        KOKORO_TTS_URL: "https://kokoro.example.test",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg; codec=mp3");
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("cartesia");
    expect(await response.arrayBuffer()).toEqual(
      new Uint8Array([73, 68, 51, 4]).buffer,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.cartesia.ai/tts/bytes",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      "X-API-Key": "cartesia-key",
      "Cartesia-Version": "2025-04-16",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model_id: "sonic-3.5",
      transcript: "Hello from Cartesia.",
      voice: { mode: "id", id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" },
      output_format: {
        container: "mp3",
        sample_rate: 44100,
        bit_rate: 128000,
      },
    });
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
    expect(billUsage.mock.calls[0]?.[0]).toMatchObject({
      model: "cartesia/sonic-3.5",
      provider: "cartesia",
      billingSource: "elevenlabs",
    });
    expect(billUsage.mock.calls[0]?.[2]).toBe(payoutAwareReservation);
    await Promise.resolve();
    expect(createUsage.mock.calls[0]?.[0]).toMatchObject({
      provider: "cartesia",
      model: "sonic-3.5",
    });
  });

  test("maps Cartesia rate limits honestly without falling back to ElevenLabs", async () => {
    cartesiaStatus = 429;
    const response = await postTts(
      { text: "Hello from Cartesia." },
      { CARTESIA_API_KEY: "cartesia-key" },
    );

    expect(response.status).toBe(429);
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
    const body = (await response.json()) as {
      error: string;
      provider: string;
      code: string;
    };
    expect(body).toEqual({
      error:
        "Cartesia text-to-speech is rate limited or quota constrained. Please try again later.",
      provider: "cartesia",
      code: "rate_limit",
    });
  });

  test("treats the proxy-injected legacy default as unpinned when Cartesia is configured", async () => {
    const response = await postTts(
      { text: "Hello.", voiceId: "EXAVITQu4vr4xnSDxMaL" },
      {
        CARTESIA_API_KEY: "cartesia-key",
        KOKORO_TTS_URL: "https://kokoro.example.test",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("cartesia");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.cartesia.ai/tts/bytes",
    );
    expect(elevenLabsTextToSpeech).not.toHaveBeenCalled();
    expect(assertSafeForPublicUse).toHaveBeenCalledTimes(1);
  });

  test("uses Kokoro for the proxy-injected legacy default when Cartesia is unset", async () => {
    allowKokoroFetch = true;
    const response = await postTts(
      { text: "Hello.", voiceId: "EXAVITQu4vr4xnSDxMaL" },
      { KOKORO_TTS_URL: "https://kokoro.example.test" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("kokoro");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://kokoro.example.test/api/tts",
    );
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

  test("rejects an empty text body before any provider selection or upstream call", async () => {
    const response = await postTts(
      { text: "", voiceId: "af_heart" },
      { KOKORO_TTS_URL: "https://kokoro.example.test" },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body).toEqual({ error: "No text provided" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
  });

  test("preserves ElevenLabs routing and observability for a custom voice", async () => {
    const response = await postTts(
      {
        text: "Hello from a custom voice.",
        voiceId: "custom-elevenlabs-voice",
      },
      { CARTESIA_API_KEY: "cartesia-key" },
    );

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

  test("returns exact bounded WAV bytes, bypasses MP3 cache, and bills after encoding", async () => {
    cacheBypass = false;
    elevenLabsBytes = new Uint8Array([1, 2, 3, 4]);
    const response = await postTts({
      text: "Codec-less playback.",
      voiceId: "custom-elevenlabs-voice",
      format: "wav",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-TTS-Cache")).toBe("miss");
    expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("elevenlabs");
    expect(response.headers.get("Server-Timing")).toContain("synthesis;dur=");
    const wav = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
    expect(elevenLabsTextToSpeech).toHaveBeenCalledWith({
      text: "Codec-less playback.",
      voiceId: "custom-elevenlabs-voice",
      modelId: undefined,
      outputFormat: "pcm_24000",
    });
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheHas).not.toHaveBeenCalled();
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(reconcileReservation).not.toHaveBeenCalled();
  });

  test("refunds the reservation and never bills malformed PCM", async () => {
    elevenLabsBytes = new Uint8Array([1, 2, 3]);
    const response = await postTts({
      text: "Do not charge failed audio.",
      voiceId: "custom-elevenlabs-voice",
      format: "wav",
    });

    expect(response.status).toBe(500);
    expect(billUsage).not.toHaveBeenCalled();
    expect(reconcileReservation).toHaveBeenCalledTimes(1);
    expect(reconcileReservation).toHaveBeenCalledWith(0);
  });

  test("cancels oversized PCM without billing, caching, or a partial WAV", async () => {
    cacheBypass = false;
    let cancelReason: unknown;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 2));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    elevenLabsStreamFactory = () => oversized;

    const response = await postTts({
      text: "Oversized PCM.",
      voiceId: "custom-elevenlabs-voice",
      format: "wav",
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).not.toBe("audio/wav");
    expect(cancelReason).toBe(
      "PCM16 response exceeded the configured byte limit",
    );
    expect(oversized.locked).toBe(false);
    expect(billUsage).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
    expect(reconcileReservation).toHaveBeenCalledWith(0);
  });

  test("releases failed PCM reads without billing, caching, or a partial WAV", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("upstream PCM read failed");
      },
    });
    elevenLabsStreamFactory = () => failing;

    const response = await postTts({
      text: "Failed PCM stream.",
      voiceId: "custom-elevenlabs-voice",
      format: "wav",
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).not.toBe("audio/wav");
    expect(failing.locked).toBe(false);
    expect(billUsage).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
    expect(reconcileReservation).toHaveBeenCalledWith(0);
  });

  // #16425: the client mints one Idempotency-Key per logical utterance (sent
  // on both the direct request and the proxy fallback); the paid path must
  // thread it into the credit reservation so a fallback retry REPLAYS the
  // committed reservation instead of charging the utterance twice.
  test("threads the Idempotency-Key header into the credit reservation", async () => {
    const response = await postTts(
      { text: "Bill me once.", voiceId: "custom-elevenlabs-voice" },
      {},
      { "Idempotency-Key": "utt-abc" },
    );
    expect(response.status).toBe(200);
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    const keyedArgs = reserveCredits.mock.calls[0] as unknown as
      | [
          Record<string, unknown>,
          Record<string, unknown>,
          { idempotencyKey?: string } | undefined,
        ]
      | undefined;
    expect(keyedArgs?.[2]).toMatchObject({
      idempotencyKey: "utt-abc",
    });
    expect(keyedArgs?.[0].requestId).toBe("voice-tts:org-1:utt-abc");
  });

  test("without the header the reservation stays unkeyed (behavior unchanged)", async () => {
    const response = await postTts({
      text: "Hi.",
      voiceId: "custom-elevenlabs-voice",
    });
    expect(response.status).toBe(200);
    const unkeyedArgs = reserveCredits.mock.calls[0] as unknown as
      | [
          Record<string, unknown>,
          Record<string, unknown>,
          { idempotencyKey?: string } | undefined,
        ]
      | undefined;
    expect(unkeyedArgs?.[2]).toBeUndefined();
  });

  test("rejects an invalid body and an over-long text before any reservation", async () => {
    const bad = await postTts({ voiceId: "custom-elevenlabs-voice" });
    expect(bad.status).toBe(400);

    const tooLong = await postTts({
      text: "x".repeat(5001),
      voiceId: "custom-elevenlabs-voice",
    });
    expect(tooLong.status).toBe(400);

    expect(reserveCredits).not.toHaveBeenCalled();
  });
});
