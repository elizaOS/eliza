/**
 * Route-level contract tests for POST /api/v1/voice/stt: the REAL Hono route
 * handler runs end to end with only auth/billing/provider modules mocked at
 * the module boundary. Covers the shared upload-validation gates (multipart,
 * size, declared-type and magic-number checks), the Deepgram prerecorded lane,
 * the Cartesia batch lane (opt-in via VOICE_BATCH_STT_PROVIDER=cartesia, plus
 * the full override matrix), the whisper
 * lane against a local OpenAI-shaped upstream (#14806 verbose_json
 * word/segment timestamps + the J3 malformed-200 boundary), the billed
 * ElevenLabs lane with its error mapping, and — gated on
 * ELIZA_VOICE_LIVE_RAILWAY=1 — the deployed Railway faster-whisper with real
 * Kokoro-synthesized speech.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  assertCreditRefundWithinReservation,
  assertValidCreditSettlementCosts,
} from "../../../../test-utils/credit-settlement-mocks";

const requireAuthOrApiKeyWithOrg = mock<() => Promise<unknown>>();

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));
// The logger is captured (not silenced) so tests can assert on what reaches
// log output: transcripts, upload filenames, and provider response bodies
// must never appear there (SEC log hygiene).
const logError = mock(() => {});
const logInfo = mock(() => {});
const logWarn = mock(() => {});
mock.module("@/lib/utils/logger", () => ({
  logger: { error: logError, info: logInfo, warn: logWarn },
}));
// Billing and provider modules are mocked so importing the route does not
// initialize DB-backed services in a unit-test process; their behavior is
// mutable per test so both lanes (free whisper, billed ElevenLabs) and the
// route's error-mapping catch are drivable through the real handler.
const billFlatUsage = mock(
  async (
    _context?: unknown,
    cost?: {
      totalCost: number;
      platformMarkup?: number;
      baseTotalCost?: number;
    },
    reservation?: { reconcile: (amount: number) => Promise<void> },
  ) => {
    await reservation?.reconcile(cost?.totalCost ?? 0.0012);
    return {
      totalCost: cost?.totalCost ?? 0.0012,
      platformMarkup: cost?.platformMarkup ?? 0.0002,
      baseTotalCost: cost?.baseTotalCost ?? 0.001,
    };
  },
);
const reconcile = mock(async (_amount: number) => {});
const payoutAwareReservation = {
  reservedAmount: 0.0012,
  reservationTransactionId: "reservation-1",
  affiliateAttribution: {
    affiliateCodeId: "00000000-0000-4000-8000-000000000010",
    affiliateUserId: "00000000-0000-4000-8000-000000000011",
    affiliateCode: "PARTNER",
    markupPercent: 0.2,
  },
  affiliatePayoutSourceId: "ai_billing:affiliate:voice-stt-test",
  reconcile,
};
const reserve = mock(async () => payoutAwareReservation);
mock.module("@/lib/services/ai-billing", () => ({
  billFlatUsage,
  reserveFlatUsageCredits: reserve,
}));
const calculateSTTCostFromCatalog = mock(async () => ({
  totalCost: 0.0012,
  baseTotalCost: 0.001,
  platformMarkup: 0.0002,
}));
mock.module("@/lib/services/ai-pricing", () => ({
  calculateSTTCostFromCatalog,
  calculateTTSCostFromCatalog: mock(async () => ({
    totalCost: 0,
    baseTotalCost: 0,
    platformMarkup: 0,
  })),
}));
class MockInsufficientCreditsError extends Error {
  required: number;
  constructor(required: number) {
    super("insufficient credits");
    this.required = required;
  }
}
mock.module("@/lib/services/credits", () => ({
  assertCreditRefundWithinReservation,
  assertValidCreditSettlementCosts,
  InsufficientCreditsError: MockInsufficientCreditsError,
}));
const speechToText = mock(
  async (_args: { audioFile: File; languageCode?: string }) =>
    "elevenlabs transcript",
);
const textToSpeech = mock(
  async (_args: { text: string; voiceId?: string; modelId?: string }) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([73, 68, 51]));
        controller.close();
      },
    }),
);
mock.module("@/lib/services/elevenlabs", () => ({
  getElevenLabsService: mock(() => ({ speechToText, textToSpeech })),
}));
const usageCreate = mock(async (_record: Record<string, unknown>) => ({}));
mock.module("@/lib/services/usage", () => ({
  usageService: { create: usageCreate },
}));
// Minimal TTS route seams let this same changed test file cover both changed
// source files without cross-file Bun mock collisions in the coverage lane.
mock.module("@/db/repositories/user-voices", () => ({
  userVoicesRepository: {
    findByElevenLabsVoiceId: async () => null,
    incrementUsageCount: async () => undefined,
  },
}));
mock.module("@/lib/services/content-safety", () => ({
  contentSafetyService: { assertSafeForPublicUse: async () => undefined },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
    toJSON() {
      return { error: this.message };
    }
  },
}));
mock.module("@/lib/services/pcm16-wav", () => ({
  drainPcm16Stream: async () => new Uint8Array(),
  drainPcm16ToWav: async () => new Uint8Array(),
  pcm16ChunksToWav: () => new Uint8Array(),
  pcm16ToWav: () => new Uint8Array(),
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
mock.module("@/lib/pricing-constants", () => ({
  CUSTOM_VOICE_TTS_MARKUP: 1.2,
  PLATFORM_MARKUP_MULTIPLIER: 1.2,
}));

const sttRoute = (await import("./route")).default;
const ttsRoute = (await import("../tts/route")).default;
const app = new Hono()
  .route("/api/v1/voice/stt", sttRoute)
  .route("/api/v1/voice/tts", ttsRoute);

/** A real RIFF/WAVE mono PCM16 file so the route's magic-number check passes. */
function synthWav(durationS = 0.25, rate = 8000): Uint8Array {
  const samples = Math.floor(durationS * rate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(
      44 + i * 2,
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000),
      true,
    );
  }
  return new Uint8Array(buffer);
}

// File() under the merged workers-types/DOM globals rejects a Uint8Array
// BlobPart, so payloads are copied into a plain ArrayBuffer first.
function bytesFile(bytes: Uint8Array, name: string, type: string): File {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new File([buffer], name, { type });
}

function wavFile(name = "probe.wav", type = "audio/wav"): File {
  return bytesFile(synthWav(), name, type);
}

function sttRequest(
  file: File | null = wavFile(),
  fields: Record<string, string> = {},
): Request {
  const form = new FormData();
  if (file) form.append("audio", file);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return new Request("http://localhost/api/v1/voice/stt", {
    method: "POST",
    body: form,
  });
}

async function cloneMultipartRequestWithHeaders(
  request: Request,
  headers: HeadersInit,
): Promise<Request> {
  const nextHeaders = new Headers(request.headers);
  const body = await request.arrayBuffer();
  for (const [key, value] of new Headers(headers)) {
    nextHeaders.set(key, value);
  }
  return new Request(request.url, {
    body,
    headers: nextHeaders,
    method: request.method,
  });
}

async function multipartBodyLength(request: Request): Promise<number> {
  return (await request.clone().arrayBuffer()).byteLength;
}

function streamRequest(
  chunks: Uint8Array[],
  headers: HeadersInit,
  onCancel: () => void = () => {},
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      onCancel();
    },
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) {
        controller.enqueue(chunk);
        return;
      }
      controller.close();
    },
  });
  return new Request("http://localhost/api/v1/voice/stt", {
    body,
    headers,
    method: "POST",
  });
}

function expectNoOversizedSideEffects() {
  expect(requireAuthOrApiKeyWithOrg).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
  expect(billFlatUsage).not.toHaveBeenCalled();
  expect(speechToText).not.toHaveBeenCalled();
  expect(usageCreate).not.toHaveBeenCalled();
}

/**
 * The merged workers-types/DOM/bun globals leave `Response#json()`'s generic
 * unresolvable at bare call sites (it infers `undefined`, which rejects every
 * `toEqual` argument); pinning the result to `unknown` keeps the assertions
 * structural without `any` casts.
 */
async function readJson(res: Response): Promise<unknown> {
  return await res.json();
}

/**
 * Structural stand-in for `instanceof File` on multipart entries: the
 * workers-types FormData iterator types entries as `string`, which makes an
 * `instanceof` narrowing a compile error (TS2358) even though the runtime
 * value is a real File for uploaded parts.
 */
function isFilePart(value: unknown): value is { name: string; type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "type" in value &&
    typeof value.name === "string" &&
    typeof value.type === "string"
  );
}

/** One-shot provider seams: answer the next transcription POST with `reply`. */
interface UpstreamCapture {
  fields: Record<string, string[]>;
  fileName: string | null;
  fileType: string | null;
}
interface DeepgramCapture {
  authorization: string | null;
  bodyBytes: Uint8Array;
  contentType: string | null;
  url: string | null;
}
interface CartesiaCapture {
  authorization: string | null;
  version: string | null;
  fields: Record<string, string[]>;
  fileName: string | null;
  fileType: string | null;
  fileBytes: Uint8Array;
  url: string | null;
}
let upstreamReply: () => Response = () => Response.json({ text: "" });
let deepgramReply: () => Response = () => Response.json({ results: {} });
let cartesiaReply: (init?: RequestInit) => Response | Promise<Response> = () =>
  Response.json({ type: "transcript", text: "" });
const captured: UpstreamCapture = {
  fields: {},
  fileName: null,
  fileType: null,
};
const deepgramCaptured: DeepgramCapture = {
  authorization: null,
  bodyBytes: new Uint8Array(),
  contentType: null,
  url: null,
};
const cartesiaCaptured: CartesiaCapture = {
  authorization: null,
  version: null,
  fields: {},
  fileName: null,
  fileType: null,
  fileBytes: new Uint8Array(),
  url: null,
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (url.origin === "https://api.deepgram.com") {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    deepgramCaptured.authorization = headers.get("authorization");
    deepgramCaptured.contentType = headers.get("content-type");
    deepgramCaptured.url = url.toString();
    const body = init?.body ?? (input instanceof Request ? input.body : null);
    const bytes = body
      ? await new Response(body).arrayBuffer()
      : new ArrayBuffer(0);
    deepgramCaptured.bodyBytes = new Uint8Array(bytes);
    return deepgramReply();
  }
  if (url.origin === "https://api.cartesia.ai") {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    cartesiaCaptured.authorization = headers.get("authorization");
    cartesiaCaptured.version = headers.get("cartesia-version");
    cartesiaCaptured.url = url.toString();
    const body = init?.body;
    if (!(body instanceof FormData)) {
      throw new Error("Cartesia mock expected a FormData body");
    }
    for (const [key, value] of body.entries()) {
      if (isFilePart(value)) {
        cartesiaCaptured.fileName = value.name;
        cartesiaCaptured.fileType = value.type;
        cartesiaCaptured.fileBytes = new Uint8Array(
          await (value as unknown as Blob).arrayBuffer(),
        );
      } else {
        const values = cartesiaCaptured.fields[key] ?? [];
        values.push(String(value));
        cartesiaCaptured.fields[key] = values;
      }
    }
    return await cartesiaReply(init);
  }
  return originalFetch.call(globalThis, input, init);
}) as typeof fetch;

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
      const form = await req.formData();
      captured.fields = {};
      captured.fileName = null;
      captured.fileType = null;
      for (const [key, value] of form.entries()) {
        if (isFilePart(value)) {
          captured.fileName = value.name;
          captured.fileType = value.type;
        } else {
          const values = captured.fields[key] ?? [];
          values.push(String(value));
          captured.fields[key] = values;
        }
      }
      return upstreamReply();
    }
    if (req.method === "POST" && url.pathname === "/api/tts") {
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "content-type": "audio/wav" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  upstream.stop(true);
});

const whisperEnv = {
  WHISPER_STT_URL: `http://localhost:${upstream.port}`,
} as never;
const deepgramEnv = {
  VOICE_BATCH_STT_PROVIDER: "deepgram",
  DEEPGRAM_API_KEY: "dg-secret",
} as never;
const deepgramAndWhisperEnv = {
  VOICE_BATCH_STT_PROVIDER: "deepgram",
  DEEPGRAM_API_KEY: "dg-secret",
  WHISPER_STT_URL: `http://localhost:${upstream.port}`,
} as never;
// Cartesia pinned: the wire-contract and billing cases below drive the lane
// directly, which now requires the explicit opt-in.
const cartesiaEnv = {
  CARTESIA_API_KEY: "car-secret",
  CARTESIA_STT_USD_PER_CREDIT: "0.00005",
  VOICE_BATCH_STT_PROVIDER: "cartesia",
} as never;
// Cartesia + Whisper both configured: free Whisper must keep the un-pinned
// default; the Cartesia lane only runs when explicitly pinned.
const cartesiaAndWhisperEnv = {
  CARTESIA_API_KEY: "car-secret",
  CARTESIA_STT_USD_PER_CREDIT: "0.00005",
  WHISPER_STT_URL: `http://localhost:${upstream.port}`,
} as never;
// Cartesia pinned with a free Whisper binding still available: proves the
// pinned lane fails closed rather than degrading to the free upstream.
const cartesiaPinnedWithWhisperEnv = {
  CARTESIA_API_KEY: "car-secret",
  CARTESIA_STT_USD_PER_CREDIT: "0.00005",
  WHISPER_STT_URL: `http://localhost:${upstream.port}`,
  VOICE_BATCH_STT_PROVIDER: "cartesia",
} as never;
// No WHISPER_STT_URL binding: the route falls through to the billed
// ElevenLabs lane.
const elevenLabsEnv = {} as never;

// The live-captured Railway faster-whisper verbose_json shape (truncated to
// the fields the route consumes) — see PR #15840 evidence.
const LIVE_SHAPE = {
  task: "transcribe",
  language: "en",
  duration: 3.05,
  text: "Hello there world, this is a timestamp test.",
  words: [
    { start: 0.0, end: 0.56, word: " Hello", probability: 0.77 },
    { start: 0.56, end: 0.8, word: " there", probability: 0.89 },
  ],
  segments: [
    {
      id: 1,
      start: 0.0,
      end: 2.62,
      text: " Hello there world, this is a timestamp test.",
      temperature: 0.0,
    },
  ],
};

const DEEPGRAM_SHAPE = {
  metadata: { duration: 1.23 },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: "Hello there world.",
            words: [
              { word: "Hello", start: 0, end: 0.31, confidence: 0.98 },
              { word: "there", start: 0.31, end: 0.52, confidence: 0.97 },
              { word: "world", start: 0.52, end: 0.84, confidence: 0.96 },
            ],
          },
        ],
      },
    ],
    utterances: [
      {
        transcript: "Hello there world.",
        start: 0,
        end: 0.84,
        words: [
          { word: "Hello", start: 0, end: 0.31 },
          { word: "there", start: 0.31, end: 0.52 },
          { word: "world", start: 0.52, end: 0.84 },
        ],
      },
    ],
  },
};

// Cartesia batch `/stt` (ink-whisper) response shape — `text` plus optional
// word timings in seconds; the batch endpoint emits no utterances/segments.
const CARTESIA_SHAPE = {
  type: "transcript",
  request_id: "req-cartesia-1",
  text: "Hello there world.",
  language: "en",
  duration: 0.84,
  words: [
    { word: "Hello", start: 0, end: 0.31 },
    { word: "there", start: 0.31, end: 0.52 },
    { word: "world", start: 0.52, end: 0.84 },
  ],
};

/** Every string that reached any logger method in this test, joined. */
function allLoggedContent(): string {
  return JSON.stringify([
    ...logError.mock.calls,
    ...logInfo.mock.calls,
    ...logWarn.mock.calls,
  ]);
}

beforeEach(() => {
  logError.mockClear();
  logInfo.mockClear();
  logWarn.mockClear();
  usageCreate.mockClear();
  calculateSTTCostFromCatalog.mockClear();
  requireAuthOrApiKeyWithOrg.mockReset();
  requireAuthOrApiKeyWithOrg.mockResolvedValue({
    user: { id: "user-1", organization_id: "org-1" },
    apiKey: null,
  });
  billFlatUsage.mockClear();
  reserve.mockReset();
  reserve.mockResolvedValue(payoutAwareReservation);
  reconcile.mockClear();
  speechToText.mockReset();
  speechToText.mockResolvedValue("elevenlabs transcript");
  textToSpeech.mockReset();
  textToSpeech.mockImplementation(
    async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([73, 68, 51]));
          controller.close();
        },
      }),
  );
  upstreamReply = () => Response.json({ text: "" });
  deepgramReply = () => Response.json(DEEPGRAM_SHAPE);
  cartesiaReply = () => Response.json(CARTESIA_SHAPE);
  captured.fields = {};
  captured.fileName = null;
  captured.fileType = null;
  deepgramCaptured.authorization = null;
  deepgramCaptured.bodyBytes = new Uint8Array();
  deepgramCaptured.contentType = null;
  deepgramCaptured.url = null;
  cartesiaCaptured.authorization = null;
  cartesiaCaptured.version = null;
  cartesiaCaptured.fields = {};
  cartesiaCaptured.fileName = null;
  cartesiaCaptured.fileType = null;
  cartesiaCaptured.fileBytes = new Uint8Array();
  cartesiaCaptured.url = null;
});

describe("POST /api/v1/voice/stt — shared upload validation gates", () => {
  test("rejects trustworthy oversized Content-Length before auth or body parsing", async () => {
    const cancel = mock(() => {});
    const res = await app.request(
      streamRequest(
        [new Uint8Array(8)],
        {
          "content-type": "multipart/form-data; boundary=oversized",
          "content-length": String(25 * 1024 * 1024 + 1),
        },
        cancel,
      ),
      undefined,
      whisperEnv,
    );

    expect(res.status).toBe(413);
    expect(await readJson(res)).toEqual({
      error: "STT multipart request body too large",
      maxBytes: 25 * 1024 * 1024,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expectNoOversizedSideEffects();
  });

  test("cancels a chunked body as soon as it exceeds the configured multipart cap", async () => {
    const cancel = mock(() => {});
    const res = await app.request(
      streamRequest(
        [new Uint8Array(8), new Uint8Array(8)],
        { "content-type": "multipart/form-data; boundary=chunked" },
        cancel,
      ),
      undefined,
      { VOICE_STT_MAX_MULTIPART_BYTES: "10" } as never,
    );

    expect(res.status).toBe(413);
    expect(await readJson(res)).toEqual({
      error: "STT multipart request body too large",
      maxBytes: 10,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expectNoOversizedSideEffects();
  });

  test("does not trust a smaller Content-Length when the streamed body grows past the cap", async () => {
    const cancel = mock(() => {});
    const res = await app.request(
      streamRequest(
        [new Uint8Array(8), new Uint8Array(8)],
        {
          "content-type": "multipart/form-data; boundary=lying",
          "content-length": "1",
        },
        cancel,
      ),
      undefined,
      { VOICE_STT_MAX_MULTIPART_BYTES: "10" } as never,
    );

    expect(res.status).toBe(413);
    expect(await readJson(res)).toEqual({
      error: "STT multipart request body too large",
      maxBytes: 10,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expectNoOversizedSideEffects();
  });

  test("removes a false smaller Content-Length from buffered in-limit multipart requests", async () => {
    upstreamReply = () => Response.json({ text: "false length accepted" });
    const base = sttRequest(wavFile(), { languageCode: "en" });
    const bodyBytes = await multipartBodyLength(base);
    const falseLength = await cloneMultipartRequestWithHeaders(base, {
      "content-length": "1",
    });

    const res = await app.request(falseLength, undefined, {
      ...(whisperEnv as unknown as Record<string, string>),
      VOICE_STT_MAX_MULTIPART_BYTES: String(bodyBytes + 1),
    } as never);

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("false length accepted");
    expect(captured.fields.language).toEqual(["en"]);
    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("accepts a multipart body exactly at the configured cap including overhead", async () => {
    upstreamReply = () => Response.json({ text: "exact boundary" });
    const base = sttRequest(wavFile(), { languageCode: "en" });
    const bodyBytes = await multipartBodyLength(base);
    const exact = await cloneMultipartRequestWithHeaders(base, {
      "content-length": String(bodyBytes),
    });

    const res = await app.request(exact, undefined, {
      ...(whisperEnv as unknown as Record<string, string>),
      VOICE_STT_MAX_MULTIPART_BYTES: String(bodyBytes),
    } as never);

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("exact boundary");
    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(speechToText).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("rejects a multipart body one byte over the configured cap including overhead", async () => {
    const base = sttRequest(wavFile(), { languageCode: "en" });
    const bodyBytes = await multipartBodyLength(base);
    const over = await cloneMultipartRequestWithHeaders(base, {
      "content-length": String(bodyBytes),
    });

    const res = await app.request(over, undefined, {
      VOICE_STT_MAX_MULTIPART_BYTES: String(bodyBytes - 1),
    } as never);

    expect(res.status).toBe(413);
    expect(await readJson(res)).toEqual({
      error: "STT multipart request body too large",
      maxBytes: bodyBytes - 1,
    });
    expectNoOversizedSideEffects();
  });

  test("invalid optional multipart limit configuration fails closed", async () => {
    const res = await app.request(sttRequest(), undefined, {
      VOICE_STT_MAX_MULTIPART_BYTES: "not-a-number",
    } as never);

    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({
      error: "Speech-to-text service is misconfigured",
    });
    expect(logError).toHaveBeenCalledWith(
      "[Voice STT API] Invalid multipart body limit configuration",
      { errorType: "Error" },
    );
    expectNoOversizedSideEffects();
  });

  test("blank multipart limit configuration fails closed instead of using the default", async () => {
    const res = await app.request(sttRequest(), undefined, {
      VOICE_STT_MAX_MULTIPART_BYTES: "   ",
    } as never);

    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({
      error: "Speech-to-text service is misconfigured",
    });
    expect(logError).toHaveBeenCalledWith(
      "[Voice STT API] Invalid multipart body limit configuration",
      { errorType: "Error" },
    );
    expectNoOversizedSideEffects();
  });

  test("a non-multipart body is a 400", async () => {
    const res = await app.request(
      new Request("http://localhost/api/v1/voice/stt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio: "nope" }),
      }),
      undefined,
      whisperEnv,
    );
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({
      error: "Expected multipart form data with audio field",
    });
  });

  test("multipart without an audio field is a 400", async () => {
    const res = await app.request(
      sttRequest(null, { languageCode: "en" }),
      undefined,
      whisperEnv,
    );
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ error: "No audio file provided" });
  });

  test("a file over the 25 MiB request cap is rejected before auth or provider calls", async () => {
    const res = await app.request(
      sttRequest(
        new File([new ArrayBuffer(25 * 1024 * 1024 + 1)], "big.wav", {
          type: "audio/wav",
        }),
      ),
      undefined,
      whisperEnv,
    );
    expect(res.status).toBe(413);
    expect(await readJson(res)).toEqual({
      error: "STT multipart request body too large",
      maxBytes: 25 * 1024 * 1024,
    });
    expectNoOversizedSideEffects();
  });

  test("an unsupported declared MIME type is a 400", async () => {
    const res = await app.request(
      sttRequest(wavFile("probe.flac", "audio/flac")),
      undefined,
      whisperEnv,
    );
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(String(body.error)).toContain("Unsupported audio format");
  });

  test("bytes with no detectable signature are rejected (magic-number gate)", async () => {
    const res = await app.request(
      sttRequest(bytesFile(new Uint8Array(64), "fake.wav", "audio/wav")),
      undefined,
      whisperEnv,
    );
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(String(body.error)).toContain("Unable to verify file type");
  });

  test("a spoofed extension (GIF bytes declared audio/wav) is rejected", async () => {
    const gif = new Uint8Array(64);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
    const res = await app.request(
      sttRequest(bytesFile(gif, "sneaky.wav", "audio/wav")),
      undefined,
      whisperEnv,
    );
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(String(body.error)).toContain(
      "File content does not match the declared format",
    );
  });

  test("an auth failure maps to a 401, never a 500", async () => {
    requireAuthOrApiKeyWithOrg.mockRejectedValue(
      new Error("Authentication required"),
    );
    const res = await app.request(sttRequest(), undefined, whisperEnv);
    expect(res.status).toBe(401);
    expect(await readJson(res)).toEqual({ error: "Unauthorized" });
  });

  test("malformed multipart remains a parse failure after auth when it is under the cap", async () => {
    const res = await app.request(
      new Request("http://localhost/api/v1/voice/stt", {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data",
        },
        body: "not a multipart body",
      }),
      undefined,
      whisperEnv,
    );

    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({
      error: "Failed to transcribe audio. Please try again.",
    });
    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(speechToText).not.toHaveBeenCalled();
    expect(billFlatUsage).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/voice/stt — whisper lane (#14806)", () => {
  test("sends verbose_json + word/segment granularities and returns ms spans", async () => {
    upstreamReply = () => Response.json(LIVE_SHAPE);
    const res = await app.request(sttRequest(), undefined, whisperEnv);

    expect(res.status).toBe(200);
    // The route's real multipart, as the upstream received it.
    expect(captured.fields.model?.length).toBe(1);
    expect(captured.fields.response_format).toEqual(["verbose_json"]);
    expect(captured.fields["timestamp_granularities[]"]).toEqual([
      "word",
      "segment",
    ]);
    expect(captured.fileName).toBe("probe.wav");
    // Bun's multipart layer re-derives the legacy x- form from the .wav name;
    // both forms pass the route's declared-type + magic-number gates.
    const receivedType = captured.fileType;
    if (receivedType === null) {
      throw new Error("upstream never received a file part");
    }
    expect(["audio/wav", "audio/x-wav"]).toContain(receivedType);

    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe(
      "Hello there world, this is a timestamp test.",
    );
    expect(body.segments).toEqual([
      {
        text: "Hello there world, this is a timestamp test.",
        startMs: 0,
        endMs: 2620,
      },
    ]);
    expect(body.words).toEqual([
      { text: "Hello", startMs: 0, endMs: 560 },
      { text: "there", startMs: 560, endMs: 800 },
    ]);
    // The free lane must never touch the billed provider or reserve credits.
    expect(speechToText).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("a plain {text} 200 keeps the legacy DTO — no timestamp keys", async () => {
    upstreamReply = () => Response.json({ text: "plain transcription" });
    const res = await app.request(sttRequest(), undefined, whisperEnv);

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("plain transcription");
    expect("segments" in body).toBe(false);
    expect("words" in body).toBe(false);
  });

  test("a partially malformed timestamp field fails closed instead of returning incomplete anchors", async () => {
    upstreamReply = () =>
      Response.json({
        text: "PII appears in the missing span",
        words: [
          { word: "PII", start: 0, end: 0.2 },
          { word: "missing", start: 0.3, end: "invalid" },
        ],
      });
    const res = await app.request(sttRequest(), undefined, whisperEnv);

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
  });

  test("a 200 with a non-object JSON body is a structured 502, not an empty transcript", async () => {
    upstreamReply = () => Response.json("not an object");
    const res = await app.request(sttRequest(), undefined, whisperEnv);

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
  });

  test("a 200 missing the required text field is a structured 502", async () => {
    upstreamReply = () => Response.json({ segments: [], duration: 1 });
    const res = await app.request(sttRequest(), undefined, whisperEnv);

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
  });

  test("a 200 with unparseable JSON is a structured 502", async () => {
    upstreamReply = () =>
      new Response("<html>proxy error</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const res = await app.request(sttRequest(), undefined, whisperEnv);

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
  });

  test("an upstream 5xx stays a structured 502 without logging its body", async () => {
    upstreamReply = () =>
      new Response("secret transcript and provider token", { status: 500 });
    const res = await app.request(sttRequest(), undefined, whisperEnv);

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
    // The provider error body must not reach logs — only the status code.
    const logs = allLoggedContent();
    expect(logs).not.toContain("secret transcript");
    expect(logs).not.toContain("provider token");
    expect(logs).toContain('"status":500');
  });

  test("a successful whisper transcription never logs the transcript or filename", async () => {
    upstreamReply = () => Response.json(LIVE_SHAPE);
    const res = await app.request(
      sttRequest(wavFile("user-recording-2026.wav")),
      undefined,
      whisperEnv,
    );

    expect(res.status).toBe(200);
    const logs = allLoggedContent();
    expect(logs).not.toContain("Hello there world");
    expect(logs).not.toContain("user-recording-2026.wav");
    // Redaction keeps observability: length metadata still lands in logs.
    expect(logs).toContain("transcriptLength");
  });

  test("rejected uploads log size and mime metadata, not the filename", async () => {
    const res = await app.request(
      sttRequest(
        bytesFile(
          new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
          "private-meeting-notes.wav",
          "audio/wav",
        ),
      ),
      undefined,
      whisperEnv,
    );

    expect(res.status).toBe(400);
    const logs = allLoggedContent();
    expect(logs).not.toContain("private-meeting-notes.wav");
    expect(logs).toContain("audioSizeBytes");
  });
});

describe("POST /api/v1/voice/stt — Deepgram prerecorded lane", () => {
  test("prefers Deepgram nova-3 over Whisper when both bindings exist", async () => {
    upstreamReply = () => Response.json({ text: "whisper should not run" });
    const res = await app.request(
      sttRequest(),
      undefined,
      deepgramAndWhisperEnv,
    );

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("Hello there world.");
    expect(deepgramCaptured.url).not.toBeNull();
    expect(captured.fileName).toBeNull();
    expect(speechToText).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(billFlatUsage).toHaveBeenCalledTimes(1);
  });

  test("does not select paid batch Deepgram from key presence alone", async () => {
    upstreamReply = () => Response.json({ text: "whisper remains default" });
    const res = await app.request(sttRequest(), undefined, {
      DEEPGRAM_API_KEY: "dg-secret",
      WHISPER_STT_URL: `http://localhost:${upstream.port}`,
    } as never);

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      transcript: "whisper remains default",
      duration_ms: expect.any(Number),
    });
    expect(deepgramCaptured.url).toBeNull();
  });

  test("fails closed when Deepgram is selected without its key", async () => {
    const res = await app.request(sttRequest(), undefined, {
      VOICE_BATCH_STT_PROVIDER: "deepgram",
      WHISPER_STT_URL: `http://localhost:${upstream.port}`,
    } as never);

    expect(res.status).toBe(503);
    expect(await readJson(res)).toEqual({
      error: "Speech-to-text service is not configured",
    });
    expect(deepgramCaptured.url).toBeNull();
    expect(captured.fileName).toBeNull();
  });

  test("sends verified raw audio bytes with auth, content type, and query shape", async () => {
    const file = wavFile("deepgram-probe.wav", "audio/wav");
    const expectedBytes = new Uint8Array(await file.arrayBuffer());
    const res = await app.request(
      sttRequest(file, { languageCode: "en-US" }),
      undefined,
      deepgramEnv,
    );

    expect(res.status).toBe(200);
    expect(deepgramCaptured.authorization).toBe("Token dg-secret");
    const deepgramContentType = deepgramCaptured.contentType;
    if (!deepgramContentType) {
      throw new Error("Deepgram request content type was not captured");
    }
    expect(["audio/wav", "audio/x-wav"]).toContain(deepgramContentType);
    expect(deepgramCaptured.bodyBytes).toEqual(expectedBytes);

    if (!deepgramCaptured.url) throw new Error("Deepgram was not called");
    const url = new URL(deepgramCaptured.url);
    expect(url.origin + url.pathname).toBe(
      "https://api.deepgram.com/v1/listen",
    );
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("utterances")).toBe("true");
    expect(url.searchParams.get("words")).toBe("true");
    expect(url.searchParams.get("language")).toBe("en-US");
  });

  test("reserves, bills, reconciles, and records Deepgram usage on success", async () => {
    const res = await app.request(
      sttRequest(wavFile(), { languageCode: "en-US" }),
      undefined,
      deepgramEnv,
    );

    expect(res.status).toBe(200);
    expect(calculateSTTCostFromCatalog).toHaveBeenCalledWith({
      model: "elevenlabs/scribe_v1",
      durationSeconds: expect.any(Number),
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    const reserveCalls = reserve.mock.calls as unknown as [
      [Record<string, unknown>, Record<string, unknown>],
    ];
    const [reserveContext, reserveCost] = reserveCalls[0];
    expect(reserveContext).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      model: "nova-3",
      provider: "deepgram",
      billingSource: "elevenlabs",
      metadata: {
        pricingProxyProvider: "elevenlabs",
        pricingProxyModel: "elevenlabs/scribe_v1",
      },
    });
    expect(reserveCost).toMatchObject({
      totalCost: 0.0012,
      baseTotalCost: 0.001,
      platformMarkup: 0.0002,
    });

    expect(billFlatUsage).toHaveBeenCalledTimes(1);
    const billFlatUsageCalls = billFlatUsage.mock.calls as unknown as [
      [
        Record<string, unknown>,
        Record<string, unknown>,
        { reconcile: typeof reconcile },
      ],
    ];
    const [billingContext, billingCost, billingReservation] =
      billFlatUsageCalls[0];
    expect(billingContext).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      apiKeyId: null,
      model: "nova-3",
      provider: "deepgram",
      billingSource: "elevenlabs",
      metadata: {
        pricingProxyProvider: "elevenlabs",
        pricingProxyModel: "elevenlabs/scribe_v1",
      },
    });
    expect(billingCost).toMatchObject({
      totalCost: 0.0012,
      baseTotalCost: 0.001,
      platformMarkup: 0.0002,
    });
    expect(billingReservation).toBe(payoutAwareReservation);
    expect(reconcile).toHaveBeenCalledWith(0.0012);

    await Bun.sleep(0);
    expect(usageCreate).toHaveBeenCalledTimes(1);
    const usageRecord = usageCreate.mock.calls[0][0] as {
      model: string;
      provider: string;
      input_cost: string;
      markup: string;
      metadata: Record<string, unknown>;
    };
    expect(usageRecord.model).toBe("nova-3");
    expect(usageRecord.provider).toBe("deepgram");
    expect(usageRecord.input_cost).toBe("0.0012");
    expect(usageRecord.markup).toBe("0.0002");
    expect(usageRecord.metadata).toMatchObject({
      billingSource: "elevenlabs",
      pricingProxyProvider: "elevenlabs",
      pricingProxyModel: "elevenlabs/scribe_v1",
      provider: "deepgram",
      model: "nova-3",
      languageCode: "en-US",
    });
    expect(usageRecord.metadata.audioFileName).toBeUndefined();
  });

  test("insufficient Deepgram credits is a 402 before the provider call", async () => {
    reserve.mockRejectedValue(new MockInsufficientCreditsError(42));
    const res = await app.request(sttRequest(), undefined, deepgramEnv);

    expect(res.status).toBe(402);
    expect(await readJson(res)).toEqual({
      error: "Insufficient credits for speech-to-text",
      required: 42,
    });
    expect(deepgramCaptured.url).toBeNull();
    expect(billFlatUsage).not.toHaveBeenCalled();
    expect(usageCreate).not.toHaveBeenCalled();
  });

  test("omits the language query when languageCode is absent", async () => {
    const res = await app.request(sttRequest(), undefined, deepgramEnv);

    expect(res.status).toBe(200);
    if (!deepgramCaptured.url) throw new Error("Deepgram was not called");
    const url = new URL(deepgramCaptured.url);
    expect(url.searchParams.has("language")).toBe(false);
  });

  test("maps Deepgram utterances and words to millisecond spans", async () => {
    const res = await app.request(sttRequest(), undefined, deepgramEnv);

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("Hello there world.");
    expect(typeof body.duration_ms).toBe("number");
    expect(body.segments).toEqual([
      { text: "Hello there world.", startMs: 0, endMs: 840 },
    ]);
    expect(body.words).toEqual([
      { text: "Hello", startMs: 0, endMs: 310 },
      { text: "there", startMs: 310, endMs: 520 },
      { text: "world", startMs: 520, endMs: 840 },
    ]);
  });

  test("a malformed 200 fails closed and does not fall back to Whisper", async () => {
    upstreamReply = () => Response.json({ text: "whisper fallback" });
    deepgramReply = () =>
      Response.json({
        results: {
          channels: [{ alternatives: [{ words: [] }] }],
          utterances: [],
        },
      });
    const res = await app.request(
      sttRequest(),
      undefined,
      deepgramAndWhisperEnv,
    );

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
    expect(captured.fileName).toBeNull();
    expect(reconcile).toHaveBeenCalledWith(0);
  });

  test("an unparseable Deepgram 200 refunds the reservation", async () => {
    deepgramReply = () =>
      new Response("<html>proxy error</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const res = await app.request(sttRequest(), undefined, deepgramEnv);

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
    expect(reconcile).toHaveBeenCalledWith(0);
    expect(billFlatUsage).not.toHaveBeenCalled();
  });

  test("an upstream error is a 502 without logging provider body or key", async () => {
    deepgramReply = () =>
      new Response("secret transcript and provider key dg-secret", {
        status: 503,
      });
    const res = await app.request(
      sttRequest(),
      undefined,
      deepgramAndWhisperEnv,
    );

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
    expect(captured.fileName).toBeNull();
    expect(reconcile).toHaveBeenCalledWith(0);
    const logs = allLoggedContent();
    expect(logs).not.toContain("secret transcript");
    expect(logs).not.toContain("dg-secret");
    expect(logs).toContain('"status":503');
  });

  test("a transport failure is a 502 without falling back to Whisper", async () => {
    upstreamReply = () => Response.json({ text: "whisper fallback" });
    deepgramReply = () => {
      throw new TypeError("secret provider socket failure");
    };
    const res = await app.request(
      sttRequest(),
      undefined,
      deepgramAndWhisperEnv,
    );

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
    expect(captured.fileName).toBeNull();
    expect(reconcile).toHaveBeenCalledWith(0);
    const logs = allLoggedContent();
    expect(logs).not.toContain("secret provider socket failure");
    expect(logs).toContain('"errorType":"TypeError"');
  });
});

describe("POST /api/v1/voice/stt — Cartesia batch lane (opt-in)", () => {
  // The lane is opt-in for the same reason the Deepgram lane above is:
  // CARTESIA_API_KEY also powers realtime Ink sessions, and batch STT's
  // un-pinned default is FREE (Whisper). A key-presence default would silently
  // bill every existing transcription and 402 every zero-credit user.
  test("a configured Cartesia key alone does not move batch STT off free Whisper", async () => {
    upstreamReply = () =>
      Response.json({ text: "whisper remains the default" });
    const res = await app.request(
      sttRequest(),
      undefined,
      cartesiaAndWhisperEnv,
    );

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      transcript: "whisper remains the default",
      duration_ms: expect.any(Number),
    });
    expect(cartesiaCaptured.url).toBeNull();
    expect(speechToText).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(billFlatUsage).not.toHaveBeenCalled();
  });

  test("VOICE_BATCH_STT_PROVIDER=cartesia runs the paid Cartesia ink-whisper lane", async () => {
    upstreamReply = () => Response.json({ text: "whisper should not run" });
    const res = await app.request(sttRequest(), undefined, {
      ...(cartesiaAndWhisperEnv as unknown as Record<string, string>),
      VOICE_BATCH_STT_PROVIDER: "cartesia",
    } as never);

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("Hello there world.");
    expect(cartesiaCaptured.url).toBe("https://api.cartesia.ai/stt");
    expect(captured.fileName).toBeNull();
    expect(speechToText).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(billFlatUsage).toHaveBeenCalledTimes(1);
  });

  test("VOICE_BATCH_STT_PROVIDER=whisper forces free Whisper past a configured Cartesia key", async () => {
    upstreamReply = () => Response.json({ text: "whisper forced" });
    const res = await app.request(sttRequest(), undefined, {
      ...(cartesiaAndWhisperEnv as unknown as Record<string, string>),
      VOICE_BATCH_STT_PROVIDER: "whisper",
    } as never);

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      transcript: "whisper forced",
      duration_ms: expect.any(Number),
    });
    expect(cartesiaCaptured.url).toBeNull();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("VOICE_BATCH_STT_PROVIDER=elevenlabs forces the billed ElevenLabs lane past Cartesia and Whisper", async () => {
    upstreamReply = () => Response.json({ text: "whisper should not run" });
    const res = await app.request(sttRequest(), undefined, {
      ...(cartesiaAndWhisperEnv as unknown as Record<string, string>),
      VOICE_BATCH_STT_PROVIDER: "elevenlabs",
    } as never);

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("elevenlabs transcript");
    expect(cartesiaCaptured.url).toBeNull();
    expect(captured.fileName).toBeNull();
    expect(speechToText).toHaveBeenCalledTimes(1);
  });

  test("VOICE_BATCH_STT_PROVIDER=deepgram still wins over a configured Cartesia key", async () => {
    const res = await app.request(sttRequest(), undefined, {
      ...(cartesiaAndWhisperEnv as unknown as Record<string, string>),
      VOICE_BATCH_STT_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: "dg-secret",
    } as never);

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("Hello there world.");
    expect(deepgramCaptured.url).not.toBeNull();
    expect(cartesiaCaptured.url).toBeNull();
  });

  test("fails closed when Cartesia is selected without its key", async () => {
    const res = await app.request(sttRequest(), undefined, {
      VOICE_BATCH_STT_PROVIDER: "cartesia",
      WHISPER_STT_URL: `http://localhost:${upstream.port}`,
    } as never);

    expect(res.status).toBe(503);
    expect(await readJson(res)).toEqual({
      error: "Speech-to-text service is not configured",
    });
    expect(cartesiaCaptured.url).toBeNull();
    expect(captured.fileName).toBeNull();
  });

  test("fails closed when Whisper is forced without its URL instead of degrading to Cartesia", async () => {
    const res = await app.request(sttRequest(), undefined, {
      VOICE_BATCH_STT_PROVIDER: "whisper",
      CARTESIA_API_KEY: "car-secret",
    } as never);

    expect(res.status).toBe(503);
    expect(await readJson(res)).toEqual({
      error: "Speech-to-text service is not configured",
    });
    expect(cartesiaCaptured.url).toBeNull();
  });

  test("sends bearer auth, version, model, word granularity, and the ISO-639-1 language", async () => {
    const file = wavFile("cartesia-probe.wav", "audio/wav");
    const expectedBytes = new Uint8Array(await file.arrayBuffer());
    const res = await app.request(
      sttRequest(file, { languageCode: "en-US" }),
      undefined,
      cartesiaEnv,
    );

    expect(res.status).toBe(200);
    expect(cartesiaCaptured.authorization).toBe("Bearer car-secret");
    expect(cartesiaCaptured.version).toBe("2026-03-01");
    expect(cartesiaCaptured.url).toBe("https://api.cartesia.ai/stt");
    expect(cartesiaCaptured.fields.model).toEqual(["ink-whisper"]);
    // BCP-47 region tags are trimmed to the ISO-639-1 primary subtag.
    expect(cartesiaCaptured.fields.language).toEqual(["en"]);
    expect(cartesiaCaptured.fields["timestamp_granularities[]"]).toEqual([
      "word",
    ]);
    expect(cartesiaCaptured.fileName).toBe("cartesia-probe.wav");
    const cartesiaFileType = cartesiaCaptured.fileType;
    if (!cartesiaFileType) {
      throw new Error("Cartesia never received a file part");
    }
    expect(["audio/wav", "audio/x-wav"]).toContain(cartesiaFileType);
    expect(cartesiaCaptured.fileBytes).toEqual(expectedBytes);
  });

  test("omits the language field when languageCode is absent", async () => {
    const res = await app.request(sttRequest(), undefined, cartesiaEnv);

    expect(res.status).toBe(200);
    expect(cartesiaCaptured.fields.language).toBeUndefined();
  });

  test("reserves, bills, reconciles, and records Cartesia usage on success", async () => {
    const res = await app.request(
      sttRequest(wavFile(), { languageCode: "en-US" }),
      undefined,
      cartesiaEnv,
    );

    expect(res.status).toBe(200);
    expect(calculateSTTCostFromCatalog).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(1);
    const reserveCalls = reserve.mock.calls as unknown as [
      [Record<string, unknown>, Record<string, unknown>],
    ];
    const [reserveContext, reserveCost] = reserveCalls[0];
    expect(reserveContext).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      model: "ink-whisper",
      provider: "cartesia",
      billingSource: "cartesia",
      metadata: { pricingSource: "cartesia_account_credit_rate" },
    });
    expect(reserveCost).toMatchObject({
      totalCost: 0.00003,
      baseTotalCost: 0.000025,
      platformMarkup: 0.000005,
    });

    expect(billFlatUsage).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(0.000025);

    await Bun.sleep(0);
    expect(usageCreate).toHaveBeenCalledTimes(1);
    const usageRecord = usageCreate.mock.calls[0][0] as {
      model: string;
      provider: string;
      input_cost: string;
      markup: string;
      metadata: Record<string, unknown>;
    };
    expect(usageRecord.model).toBe("ink-whisper");
    expect(usageRecord.provider).toBe("cartesia");
    expect(usageRecord.input_cost).toBe("0.000025");
    expect(usageRecord.markup).toBe("0.000004");
    expect(usageRecord.metadata).toMatchObject({
      billingSource: "cartesia",
      pricingSource: "cartesia_account_credit_rate",
      provider: "cartesia",
      model: "ink-whisper",
      languageCode: "en-US",
      durationSeconds: 0.84,
    });
    expect(usageRecord.metadata.audioFileName).toBeUndefined();
  });

  test("insufficient Cartesia credits is a 402 before the provider call", async () => {
    reserve.mockRejectedValue(new MockInsufficientCreditsError(42));
    const res = await app.request(sttRequest(), undefined, cartesiaEnv);

    expect(res.status).toBe(402);
    expect(await readJson(res)).toEqual({
      error: "Insufficient credits for speech-to-text",
      required: 42,
    });
    expect(cartesiaCaptured.url).toBeNull();
    expect(billFlatUsage).not.toHaveBeenCalled();
    expect(usageCreate).not.toHaveBeenCalled();
  });

  test("maps Cartesia word timings to millisecond spans", async () => {
    const res = await app.request(sttRequest(), undefined, cartesiaEnv);

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("Hello there world.");
    expect(typeof body.duration_ms).toBe("number");
    expect(body.words).toEqual([
      { text: "Hello", startMs: 0, endMs: 310 },
      { text: "there", startMs: 310, endMs: 520 },
      { text: "world", startMs: 520, endMs: 840 },
    ]);
    expect("segments" in body).toBe(false);
  });

  test("a words-free Cartesia payload keeps the plain DTO", async () => {
    cartesiaReply = () =>
      Response.json({
        type: "transcript",
        text: "plain cartesia",
        duration: 0.84,
      });
    const res = await app.request(sttRequest(), undefined, cartesiaEnv);

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("plain cartesia");
    expect("words" in body).toBe(false);
  });

  test("a malformed Cartesia 200 fails closed, refunds, and never falls back to Whisper", async () => {
    upstreamReply = () => Response.json({ text: "whisper fallback" });
    cartesiaReply = () => Response.json({ type: "transcript" });
    const res = await app.request(
      sttRequest(),
      undefined,
      cartesiaPinnedWithWhisperEnv,
    );

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
    expect(captured.fileName).toBeNull();
    expect(reconcile).toHaveBeenCalledWith(0);
    expect(billFlatUsage).not.toHaveBeenCalled();
  });

  test("partially malformed Cartesia word timings fail closed instead of dropping spans", async () => {
    cartesiaReply = () =>
      Response.json({
        type: "transcript",
        text: "PII appears in the missing span",
        words: [
          { word: "PII", start: 0, end: 0.2 },
          { word: "missing", start: 0.3, end: "invalid" },
        ],
      });
    const res = await app.request(sttRequest(), undefined, cartesiaEnv);

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
    expect(reconcile).toHaveBeenCalledWith(0);
  });

  test("an upstream Cartesia error is a 502 without logging provider body or key", async () => {
    cartesiaReply = () =>
      new Response("secret transcript and provider key car-secret", {
        status: 503,
      });
    const res = await app.request(
      sttRequest(),
      undefined,
      cartesiaPinnedWithWhisperEnv,
    );

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
    expect(captured.fileName).toBeNull();
    expect(reconcile).toHaveBeenCalledWith(0);
    const logs = allLoggedContent();
    expect(logs).not.toContain("secret transcript");
    expect(logs).not.toContain("car-secret");
    expect(logs).toContain('"status":503');
  });

  test("a transport failure refunds and is a 502 logged as its type only", async () => {
    cartesiaReply = () => {
      throw new TypeError("secret provider socket failure");
    };
    const res = await app.request(
      sttRequest(),
      undefined,
      cartesiaPinnedWithWhisperEnv,
    );

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
    expect(captured.fileName).toBeNull();
    expect(reconcile).toHaveBeenCalledWith(0);
    const logs = allLoggedContent();
    expect(logs).not.toContain("secret provider socket failure");
    expect(logs).toContain('"errorType":"TypeError"');
  });

  test("an unknown provider configuration fails closed before any upstream call", async () => {
    const res = await app.request(sttRequest(), undefined, {
      VOICE_BATCH_STT_PROVIDER: "cartesiaa",
      CARTESIA_API_KEY: "car-secret",
      CARTESIA_STT_USD_PER_CREDIT: "0.00005",
    } as never);

    expect(res.status).toBe(503);
    expect(await readJson(res)).toEqual({
      error: "Speech-to-text service is not configured",
    });
    expect(cartesiaCaptured.url).toBeNull();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("a missing account credit rate fails closed before reserving credits", async () => {
    const res = await app.request(sttRequest(), undefined, {
      VOICE_BATCH_STT_PROVIDER: "cartesia",
      CARTESIA_API_KEY: "car-secret",
    } as never);

    expect(res.status).toBe(503);
    expect(cartesiaCaptured.url).toBeNull();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("a Cartesia timeout refunds the reservation and returns a typed 504", async () => {
    cartesiaReply = (init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Cartesia timeout test expected a signal");
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const res = await app.request(sttRequest(), undefined, {
      ...(cartesiaEnv as Record<string, string>),
      CARTESIA_BATCH_STT_TIMEOUT_MS: "1",
    } as never);

    expect(res.status).toBe(504);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text timed out" });
    expect(reconcile).toHaveBeenCalledWith(0);
    expect(billFlatUsage).not.toHaveBeenCalled();
  });

  test("a stalled Cartesia response body refunds and returns a typed 504", async () => {
    cartesiaReply = (init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const signal = init?.signal;
            if (!signal) {
              throw new Error("Cartesia body timeout test expected a signal");
            }
            signal.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const res = await app.request(sttRequest(), undefined, {
      ...(cartesiaEnv as Record<string, string>),
      CARTESIA_BATCH_STT_TIMEOUT_MS: "1",
    } as never);

    expect(res.status).toBe(504);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text timed out" });
    expect(reconcile).toHaveBeenCalledWith(0);
    expect(billFlatUsage).not.toHaveBeenCalled();
  });

  test("a success payload without authoritative duration is rejected and refunded", async () => {
    cartesiaReply = () =>
      Response.json({ type: "transcript", text: "missing duration" });
    const res = await app.request(sttRequest(), undefined, cartesiaEnv);

    expect(res.status).toBe(502);
    expect(reconcile).toHaveBeenCalledWith(0);
    expect(billFlatUsage).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/voice/stt — billed ElevenLabs lane", () => {
  test("transcribes, bills, and keeps the legacy DTO (no timestamp keys)", async () => {
    const res = await app.request(
      sttRequest(wavFile(), { languageCode: "fr" }),
      undefined,
      elevenLabsEnv,
    );

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body.transcript).toBe("elevenlabs transcript");
    expect(typeof body.duration_ms).toBe("number");
    expect("segments" in body).toBe(false);
    expect("words" in body).toBe(false);

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(billFlatUsage).toHaveBeenCalledTimes(1);
    expect(speechToText).toHaveBeenCalledTimes(1);
    const call = speechToText.mock.calls[0][0];
    expect(call.audioFile.name).toBe("probe.wav");
    expect(call.languageCode).toBe("fr");

    // Log hygiene: the transcript and upload filename reach the provider and
    // the response, but never the logs.
    const logs = allLoggedContent();
    expect(logs).not.toContain("elevenlabs transcript");
    expect(logs).not.toContain("probe.wav");
    expect(logs).toContain("transcriptLength");

    // Usage-record hygiene: metadata drops the raw filename (can carry PII)
    // but keeps size/duration/length metrics and the languageCode enum.
    await Bun.sleep(0); // usage record write is fire-and-forget
    expect(usageCreate).toHaveBeenCalledTimes(1);
    const usageRecord = usageCreate.mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(usageRecord.metadata.audioFileName).toBeUndefined();
    expect(usageRecord.metadata.languageCode).toBe("fr");
    expect(usageRecord.metadata.audioSizeBytes).toBeGreaterThan(0);
    expect(usageRecord.metadata.transcriptLength).toBe(
      "elevenlabs transcript".length,
    );
  });

  test("insufficient credits is a 402 carrying the required amount", async () => {
    reserve.mockRejectedValue(new MockInsufficientCreditsError(42));
    const res = await app.request(sttRequest(), undefined, elevenLabsEnv);

    expect(res.status).toBe(402);
    expect(await readJson(res)).toEqual({
      error: "Insufficient credits for speech-to-text",
      required: 42,
    });
    expect(speechToText).not.toHaveBeenCalled();
  });

  test("a provider rate-limit failure is a 429 and refunds the reservation", async () => {
    speechToText.mockRejectedValue(new Error("Rate limit exceeded"));
    const res = await app.request(sttRequest(), undefined, elevenLabsEnv);

    expect(res.status).toBe(429);
    expect(await readJson(res)).toEqual({
      error: "Rate limit exceeded. Please try again in a moment.",
    });
    expect(reconcile).toHaveBeenCalledWith(0);
  });

  test("a provider error embedding request content is logged as its type only", async () => {
    // Provider SDK errors can carry the request/response payload in their
    // message. The route's catch must log only the error type, never the
    // message or the error object itself.
    speechToText.mockRejectedValue(
      new Error(
        'transcription failed for utterance: "my social security number is"',
      ),
    );
    const res = await app.request(sttRequest(), undefined, elevenLabsEnv);

    expect(res.status).toBe(500);
    const logs = allLoggedContent();
    expect(logs).not.toContain("social security");
    expect(logs).not.toContain("utterance");
    expect(logs).toContain('"errorType":"Error"');
  });

  test("a quota failure naming a paid tier is a 402 upgrade prompt", async () => {
    speechToText.mockRejectedValue(
      Object.assign(new Error("quota reached"), {
        body: { detail: { message: "requires enterprise plan" } },
      }),
    );
    const res = await app.request(sttRequest(), undefined, elevenLabsEnv);

    expect(res.status).toBe(402);
    expect(await readJson(res)).toEqual({
      error: "Speech-to-Text requires a paid plan. Please upgrade to continue.",
    });
  });

  test("a plain quota/403 failure degrades to a structured 503", async () => {
    speechToText.mockRejectedValue(
      Object.assign(new Error("provider refused"), { statusCode: 403 }),
    );
    const res = await app.request(sttRequest(), undefined, elevenLabsEnv);

    expect(res.status).toBe(503);
    expect(await readJson(res)).toEqual({
      error:
        "Speech-to-text service is temporarily unavailable due to high demand. Please try again shortly.",
      type: "service_unavailable",
      retryAfter: "5 minutes",
    });
    expect(reconcile).toHaveBeenCalledWith(0);
  });

  test("a missing provider key maps to a 500 'Service not configured'", async () => {
    speechToText.mockRejectedValue(new Error("ELEVENLABS_API_KEY is not set"));
    const res = await app.request(sttRequest(), undefined, elevenLabsEnv);

    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({ error: "Service not configured" });
  });

  test("an unrecognized provider failure is a generic 500, refunded", async () => {
    speechToText.mockRejectedValue(new Error("socket hang up"));
    const res = await app.request(sttRequest(), undefined, elevenLabsEnv);

    expect(res.status).toBe(500);
    expect(await readJson(res)).toEqual({
      error: "Failed to transcribe audio. Please try again.",
    });
    expect(reconcile).toHaveBeenCalledWith(0);
  });
});

describe("POST /api/v1/voice/tts — log redaction", () => {
  test("keeps the paid ElevenLabs response contract", async () => {
    const res = await app.request(
      new Request("http://localhost/api/v1/voice/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "A normal synthesized response." }),
      }),
      undefined,
      {} as never,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(await res.arrayBuffer()).toEqual(
      new Uint8Array([73, 68, 51]).buffer,
    );
    expect(textToSpeech).toHaveBeenCalledTimes(1);
    await Bun.sleep(0);
    expect(usageCreate).toHaveBeenCalledTimes(1);
  });

  test("keeps the free Kokoro response contract", async () => {
    const res = await app.request(
      new Request("http://localhost/api/v1/voice/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "A normal synthesized response.",
          voiceId: "EXAVITQu4vr4xnSDxMaL",
        }),
      }),
      undefined,
      { KOKORO_TTS_URL: `http://localhost:${upstream.port}` } as never,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("x-eliza-tts-provider")).toBe("kokoro");
    expect(textToSpeech).not.toHaveBeenCalled();
  });

  test("logs only the error type when synthesis errors contain private text", async () => {
    textToSpeech.mockRejectedValueOnce(
      new Error('provider payload echoed: "private medical transcript"'),
    );

    const res = await app.request(
      new Request("http://localhost/api/v1/voice/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "private medical transcript" }),
      }),
      undefined,
      {} as never,
    );

    expect(res.status).toBe(500);
    const logs = allLoggedContent();
    expect(logs).not.toContain("private medical transcript");
    expect(logs).not.toContain("provider payload echoed");
    expect(logs).toContain('"errorType":"Error"');
  });
});

// ── Live lane (deployed Railway faster-whisper + Kokoro speech) ─────────────
const LIVE = process.env.ELIZA_VOICE_LIVE_RAILWAY === "1";
const KOKORO_TTS_URL =
  process.env.KOKORO_TTS_URL ||
  "https://kokoro-tts-production-aa4b.up.railway.app";
const LIVE_WHISPER_URL =
  process.env.WHISPER_STT_URL ||
  "https://whisper-stt-production-6fc7.up.railway.app";
const maybeLive = LIVE ? test : test.skip;

describe("POST /api/v1/voice/stt — LIVE Railway whisper through the real route", () => {
  maybeLive(
    "returns real word/segment ms spans for real synthesized speech",
    async () => {
      const ttsRes = await fetch(`${KOKORO_TTS_URL}/api/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "hello there world, this is a timestamp test",
          voice: "af_heart",
          speed: 1.0,
        }),
      });
      expect(ttsRes.status).toBe(200);
      const speech = await ttsRes.arrayBuffer();

      const form = new FormData();
      form.append(
        "audio",
        new File([speech], "live.wav", { type: "audio/wav" }),
      );
      const res = await app.request(
        new Request("http://localhost/api/v1/voice/stt", {
          method: "POST",
          body: form,
        }),
        undefined,
        { WHISPER_STT_URL: LIVE_WHISPER_URL } as never,
      );

      expect(res.status).toBe(200);
      const body = (await readJson(res)) as {
        transcript: string;
        segments?: Array<{ text: string; startMs: number; endMs: number }>;
        words?: Array<{ text: string; startMs: number; endMs: number }>;
      };
      console.log("[live-route-dto]", JSON.stringify(body).slice(0, 1200));
      expect(body.transcript.toLowerCase()).toContain("timestamp");
      expect(body.words?.length ?? 0).toBeGreaterThan(4);
      expect(body.segments?.length ?? 0).toBeGreaterThan(0);
      for (const span of [...(body.words ?? []), ...(body.segments ?? [])]) {
        expect(Number.isFinite(span.startMs)).toBe(true);
        expect(span.endMs).toBeGreaterThanOrEqual(span.startMs);
      }
    },
    120_000,
  );
});
