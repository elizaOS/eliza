/**
 * Route-level contract tests for POST /api/v1/voice/stt: the REAL Hono route
 * handler runs end to end with only auth/billing/provider modules mocked at
 * the module boundary. Covers the shared upload-validation gates (multipart,
 * size, declared-type and magic-number checks), the whisper lane against a
 * local OpenAI-shaped upstream (#14806 verbose_json word/segment timestamps +
 * the J3 malformed-200 boundary), the billed ElevenLabs lane with its error
 * mapping, and — gated on ELIZA_VOICE_LIVE_RAILWAY=1 — the deployed Railway
 * faster-whisper with real Kokoro-synthesized speech.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock<() => Promise<unknown>>();

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));
// Billing and provider modules are mocked so importing the route does not
// initialize DB-backed services in a unit-test process; their behavior is
// mutable per test so both lanes (free whisper, billed ElevenLabs) and the
// route's error-mapping catch are drivable through the real handler.
const billFlatUsage = mock(async () => ({
  totalCost: 0,
  platformMarkup: 0,
  baseTotalCost: 0,
}));
mock.module("@/lib/services/ai-billing", () => ({ billFlatUsage }));
mock.module("@/lib/services/ai-pricing", () => ({
  calculateSTTCostFromCatalog: mock(async () => ({ totalCost: 0 })),
}));
class MockInsufficientCreditsError extends Error {
  required: number;
  constructor(required: number) {
    super("insufficient credits");
    this.required = required;
  }
}
const reconcile = mock(async (_amount: number) => {});
const reserve = mock(async () => ({ reconcile }));
mock.module("@/lib/services/credits", () => ({
  creditsService: { reserve },
  InsufficientCreditsError: MockInsufficientCreditsError,
}));
const speechToText = mock(
  async (_args: { audioFile: File; languageCode?: string }) =>
    "elevenlabs transcript",
);
mock.module("@/lib/services/elevenlabs", () => ({
  getElevenLabsService: mock(() => ({ speechToText })),
}));
mock.module("@/lib/services/usage", () => ({
  usageService: { create: mock(async () => ({})) },
}));

const sttRoute = (await import("./route")).default;
const app = new Hono().route("/api/v1/voice/stt", sttRoute);

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

/** One-shot local upstream: answers the next transcription POST with `reply`. */
interface UpstreamCapture {
  fields: Record<string, string[]>;
  fileName: string | null;
  fileType: string | null;
}
let upstreamReply: () => Response = () => Response.json({ text: "" });
const captured: UpstreamCapture = {
  fields: {},
  fileName: null,
  fileType: null,
};

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
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => upstream.stop(true));

const whisperEnv = {
  WHISPER_STT_URL: `http://localhost:${upstream.port}`,
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

beforeEach(() => {
  requireAuthOrApiKeyWithOrg.mockReset();
  requireAuthOrApiKeyWithOrg.mockResolvedValue({
    user: { id: "user-1", organization_id: "org-1" },
    apiKey: null,
  });
  billFlatUsage.mockClear();
  reserve.mockReset();
  reserve.mockResolvedValue({ reconcile });
  reconcile.mockClear();
  speechToText.mockReset();
  speechToText.mockResolvedValue("elevenlabs transcript");
  upstreamReply = () => Response.json({ text: "" });
});

describe("POST /api/v1/voice/stt — shared upload validation gates", () => {
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

  test("a file over the 25MB cap is rejected before any provider call", async () => {
    const res = await app.request(
      sttRequest(
        new File([new ArrayBuffer(25 * 1024 * 1024 + 1)], "big.wav", {
          type: "audio/wav",
        }),
      ),
      undefined,
      whisperEnv,
    );
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({
      error: "File too large. Maximum size is 25MB",
    });
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

  test("an upstream 5xx stays a structured 502", async () => {
    upstreamReply = () => new Response("boom", { status: 500 });
    const res = await app.request(sttRequest(), undefined, whisperEnv);

    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ error: "Speech-to-text failed" });
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
