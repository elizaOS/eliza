/**
 * Route-level contract tests for the /api/v1/voice/stt whisper lane (#14806):
 * the REAL Hono route handler runs end to end against a local OpenAI-shaped
 * upstream (auth + billing modules mocked at the module boundary, everything
 * else real) — proving the multipart the route SENDS (model, verbose_json,
 * word+segment granularities), the ms-converted segments/words DTO it returns,
 * and the J3 boundary: a malformed 200 (non-object body, missing `text`,
 * unparseable JSON) becomes a structured 502, never a healthy empty
 * transcript. A final describe, gated on ELIZA_VOICE_LIVE_RAILWAY=1, drives
 * the same real route against the deployed Railway faster-whisper with real
 * Kokoro-synthesized speech.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock<() => Promise<unknown>>();

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));
// The whisper lane never bills; these modules are mocked so importing the
// route does not initialize DB-backed services in a unit-test process.
mock.module("@/lib/services/ai-billing", () => ({
  billFlatUsage: mock(async () => ({
    totalCost: 0,
    platformMarkup: 0,
    baseTotalCost: 0,
  })),
}));
mock.module("@/lib/services/ai-pricing", () => ({
  calculateSTTCostFromCatalog: mock(async () => ({ totalCost: 0 })),
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: {
    reserve: mock(async () => ({ reconcile: async () => {} })),
  },
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));
mock.module("@/lib/services/elevenlabs", () => ({
  getElevenLabsService: mock(() => ({
    speechToText: async () => {
      throw new Error("elevenlabs must not be reached in the whisper lane");
    },
  })),
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

function sttRequest(): Request {
  const form = new FormData();
  const wav = synthWav();
  const wavBuffer = new ArrayBuffer(wav.byteLength);
  new Uint8Array(wavBuffer).set(wav);
  form.append(
    "audio",
    new File([wavBuffer], "probe.wav", { type: "audio/wav" }),
  );
  return new Request("http://localhost/api/v1/voice/stt", {
    method: "POST",
    body: form,
  });
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
        if (value instanceof File) {
          captured.fileName = value.name;
          captured.fileType = value.type;
        } else {
          (captured.fields[key] ??= []).push(String(value));
        }
      }
      return upstreamReply();
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => upstream.stop(true));

const env = {
  WHISPER_STT_URL: `http://localhost:${upstream.port}`,
} as never;

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
  upstreamReply = () => Response.json({ text: "" });
});

describe("POST /api/v1/voice/stt — whisper lane (#14806)", () => {
  test("sends verbose_json + word/segment granularities and returns ms spans", async () => {
    upstreamReply = () => Response.json(LIVE_SHAPE);
    const res = await app.request(sttRequest(), undefined, env);

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
    expect(["audio/wav", "audio/x-wav"]).toContain(captured.fileType);

    const body = (await res.json()) as Record<string, unknown>;
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
  });

  test("a plain {text} 200 keeps the legacy DTO — no timestamp keys", async () => {
    upstreamReply = () => Response.json({ text: "plain transcription" });
    const res = await app.request(sttRequest(), undefined, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.transcript).toBe("plain transcription");
    expect("segments" in body).toBe(false);
    expect("words" in body).toBe(false);
  });

  test("a 200 with a non-object JSON body is a structured 502, not an empty transcript", async () => {
    upstreamReply = () => Response.json("not an object");
    const res = await app.request(sttRequest(), undefined, env);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Speech-to-text failed" });
  });

  test("a 200 missing the required text field is a structured 502", async () => {
    upstreamReply = () => Response.json({ segments: [], duration: 1 });
    const res = await app.request(sttRequest(), undefined, env);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Speech-to-text failed" });
  });

  test("a 200 with unparseable JSON is a structured 502", async () => {
    upstreamReply = () =>
      new Response("<html>proxy error</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const res = await app.request(sttRequest(), undefined, env);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Speech-to-text failed" });
  });

  test("an upstream 5xx stays a structured 502", async () => {
    upstreamReply = () => new Response("boom", { status: 500 });
    const res = await app.request(sttRequest(), undefined, env);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Speech-to-text failed" });
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
      const body = (await res.json()) as {
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
