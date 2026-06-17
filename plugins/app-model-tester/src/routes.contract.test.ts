import type http from "node:http";
import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  audioBytesToBase64,
  coerceText,
  dataUrlToBytes,
  decodePcm16Wav,
  detectVoiceActivity,
  handleModelTesterRoute,
  makeDefaultAudioPayload,
  readNumberArray,
  toPcmPayload,
} from "./routes.js";

// ---------------------------------------------------------------------------
// Fake Node HTTP req/res harness. The route handler is invoked through the
// runtime's `rawPath: true` plugin-route adapter, which attaches the parsed
// JSON body as `req.body` (honoured by readCompatJsonBody) — so we set `body`
// directly rather than streaming bytes.
// ---------------------------------------------------------------------------
interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function fakeReq(body?: unknown): http.IncomingMessage {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body,
  } as unknown as http.IncomingMessage;
}

function fakeRes(): { res: http.ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, headers: {}, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      if (typeof chunk === "string") captured.body = chunk;
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

/** Minimal runtime stub: a model registry Map + getModel + useModel. */
function makeRuntime(opts: {
  registered?: Partial<Record<ModelTypeName, string[]>>;
  useModel?: (
    modelType: ModelTypeName,
    params: unknown,
    provider?: string,
  ) => unknown;
}): IAgentRuntime {
  const models = new Map<ModelTypeName, Array<{ provider: string }>>();
  for (const [type, providers] of Object.entries(opts.registered ?? {})) {
    models.set(
      type as ModelTypeName,
      (providers as string[]).map((provider) => ({ provider })),
    );
  }
  return {
    models,
    getModel: (modelType: ModelTypeName) =>
      models.has(modelType) ? () => undefined : undefined,
    useModel: async (
      modelType: ModelTypeName,
      params: unknown,
      provider?: string,
    ) => {
      if (!opts.useModel) throw new Error("useModel not configured");
      return opts.useModel(modelType, params, provider);
    },
  } as unknown as IAgentRuntime;
}

interface StatusEnvelope {
  tests: Array<{
    id: string;
    label: string;
    modelType: string;
    available: boolean;
    providers: string[];
  }>;
}

interface RunEnvelope {
  ok: boolean;
  test: string;
  durationMs?: number;
  output?: unknown;
  error?: string;
}

describe("GET /api/model-tester/status", () => {
  it("returns the 8-probe envelope reflecting the runtime model registry", async () => {
    const runtime = makeRuntime({
      registered: {
        [ModelType.TEXT_SMALL]: ["eliza-local-inference", "anthropic"],
        [ModelType.TEXT_EMBEDDING]: ["openai"],
      },
    });
    const { res, captured } = fakeRes();

    await handleModelTesterRoute(
      fakeReq(),
      res,
      "/api/model-tester/status",
      "GET",
      runtime,
    );

    expect(captured.statusCode).toBe(200);
    const json = JSON.parse(captured.body) as StatusEnvelope;
    expect(json.tests).toHaveLength(8);

    const byId = new Map(json.tests.map((t) => [t.id, t]));

    const textSmall = byId.get("text-small");
    expect(textSmall?.modelType).toBe(ModelType.TEXT_SMALL);
    expect(textSmall?.available).toBe(true);
    expect(textSmall?.providers).toEqual([
      "eliza-local-inference",
      "anthropic",
    ]);

    const embedding = byId.get("embedding");
    expect(embedding?.available).toBe(true);
    expect(embedding?.providers).toEqual(["openai"]);

    // Unregistered probe -> not available, empty providers.
    const tts = byId.get("text-to-speech");
    expect(tts?.available).toBe(false);
    expect(tts?.providers).toEqual([]);

    // VAD is pure JS — always available with the browser provider tag.
    const vad = byId.get("vad");
    expect(vad?.available).toBe(true);
    expect(vad?.providers).toEqual(["browser-vad"]);
    expect(vad?.modelType).toBe("VAD");
  });
});

describe("POST /api/model-tester/run", () => {
  it("vad: detects a tone in the default 440Hz sine and silence in zeros", async () => {
    const runtime = makeRuntime({});

    // Default audio (1s 440Hz sine) -> at least one active segment.
    {
      const { res, captured } = fakeRes();
      await handleModelTesterRoute(
        fakeReq({ test: "vad" }),
        res,
        "/api/model-tester/run",
        "POST",
        runtime,
      );
      const json = JSON.parse(captured.body) as RunEnvelope;
      expect(json.ok).toBe(true);
      expect(json.test).toBe("vad");
      const output = json.output as {
        segments: unknown[];
        activeMs: number;
        totalMs: number;
        peakRms: number;
      };
      expect(output.segments.length).toBeGreaterThanOrEqual(1);
      expect(output.totalMs).toBe(1000);
      expect(output.peakRms).toBeGreaterThan(0);
      expect(output.activeMs).toBeGreaterThan(0);
    }

    // Explicit silence -> zero segments.
    {
      const { res, captured } = fakeRes();
      await handleModelTesterRoute(
        fakeReq({
          test: "vad",
          pcmSamples: new Array(16_000).fill(0),
          sampleRateHz: 16_000,
        }),
        res,
        "/api/model-tester/run",
        "POST",
        runtime,
      );
      const json = JSON.parse(captured.body) as RunEnvelope;
      const output = json.output as {
        segments: unknown[];
        peakRms: number;
        totalMs: number;
      };
      expect(output.segments).toHaveLength(0);
      expect(output.peakRms).toBe(0);
      expect(output.totalMs).toBe(1000);
    }
  });

  it("text-small: coerces a plain-string model result into {text,chunks,provider}", async () => {
    const runtime = makeRuntime({
      registered: { [ModelType.TEXT_SMALL]: ["default"] },
      useModel: (modelType) => {
        if (modelType === ModelType.TEXT_SMALL) return "hello world";
        throw new Error(`unexpected model ${String(modelType)}`);
      },
    });
    const { res, captured } = fakeRes();

    await handleModelTesterRoute(
      fakeReq({ test: "text-small", prompt: "ping" }),
      res,
      "/api/model-tester/run",
      "POST",
      runtime,
    );

    expect(captured.statusCode).toBe(200);
    const json = JSON.parse(captured.body) as RunEnvelope;
    expect(json.ok).toBe(true);
    expect(json.test).toBe("text-small");
    expect(typeof json.durationMs).toBe("number");
    const output = json.output as {
      text: string;
      chunks: string[];
      provider: string;
    };
    expect(output.text).toBe("hello world");
    // First provider tried is the default (undefined -> "default").
    expect(output.provider).toBe("default");
  });

  it("text-small: coerces a {text} object result via coerceText", async () => {
    const runtime = makeRuntime({
      useModel: (modelType) =>
        modelType === ModelType.TEXT_SMALL ? { text: "hi there" } : null,
    });
    const { res, captured } = fakeRes();

    await handleModelTesterRoute(
      fakeReq({ test: "text-small" }),
      res,
      "/api/model-tester/run",
      "POST",
      runtime,
    );

    const json = JSON.parse(captured.body) as RunEnvelope;
    expect(json.ok).toBe(true);
    expect((json.output as { text: string }).text).toBe("hi there");
  });

  it("embedding: returns dimensions + an 8-element preview", async () => {
    const vector = Array.from({ length: 32 }, (_, i) => i / 100);
    const runtime = makeRuntime({
      useModel: (modelType) =>
        modelType === ModelType.TEXT_EMBEDDING ? vector : null,
    });
    const { res, captured } = fakeRes();

    await handleModelTesterRoute(
      fakeReq({ test: "embedding" }),
      res,
      "/api/model-tester/run",
      "POST",
      runtime,
    );

    const json = JSON.parse(captured.body) as RunEnvelope;
    expect(json.ok).toBe(true);
    const output = json.output as { dimensions: number; preview: number[] };
    expect(output.dimensions).toBe(32);
    expect(output.preview).toHaveLength(8);
    expect(output.preview).toEqual(vector.slice(0, 8));
  });

  it("surfaces a thrown probe error as HTTP 200 {ok:false} (not 5xx)", async () => {
    const runtime = makeRuntime({
      useModel: () => {
        throw new Error("model exploded");
      },
    });
    const { res, captured } = fakeRes();

    await handleModelTesterRoute(
      fakeReq({ test: "embedding" }),
      res,
      "/api/model-tester/run",
      "POST",
      runtime,
    );

    // Error is surfaced in the envelope, not as a 5xx.
    expect(captured.statusCode).toBe(200);
    const json = JSON.parse(captured.body) as RunEnvelope;
    expect(json.ok).toBe(false);
    expect(json.test).toBe("embedding");
    expect(json.error).toContain("model exploded");
  });
});

// ---------------------------------------------------------------------------
// Parser unit coverage over real-shaped data. These functions parse real model
// outputs (TTS audio buffers, WAV files, data URLs, PCM arrays); the fixtures
// are constructed to match the byte shapes the runtime actually produces.
// ---------------------------------------------------------------------------
describe("audioBytesToBase64", () => {
  it("detects audio/wav from a real RIFF Uint8Array", () => {
    const wav = makeDefaultAudioPayload().wav;
    const out = audioBytesToBase64(new Uint8Array(wav));
    expect(out.contentType).toBe("audio/wav");
    expect(out.byteLength).toBe(wav.byteLength);
    // Round-trips back to the same bytes.
    expect(Buffer.from(out.base64, "base64").equals(wav)).toBe(true);
  });

  it("detects audio/ogg from an OggS-prefixed ArrayBuffer", () => {
    const bytes = new Uint8Array(12);
    bytes.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
    const out = audioBytesToBase64(bytes.buffer);
    expect(out.contentType).toBe("audio/ogg");
  });

  it("detects audio/mpeg from a 0xFF MP3 frame-synced buffer", () => {
    // Real MP3 streams without an ID3v2 header begin with the 11-bit frame sync
    // (first byte 0xFF). The source detects this via the `bytes[0] === 0xff`
    // branch in detectAudioContentType.
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    expect(audioBytesToBase64(mp3).contentType).toBe("audio/mpeg");
  });

  it("throws when handed a non-buffer value", () => {
    expect(() => audioBytesToBase64({ not: "audio" })).toThrow(
      /non-audio output/,
    );
  });
});

describe("decodePcm16Wav", () => {
  it("round-trips the default 16kHz 16-bit WAV into in-range samples", () => {
    const { wav } = makeDefaultAudioPayload();
    const { pcm, sampleRate } = decodePcm16Wav(new Uint8Array(wav));
    expect(sampleRate).toBe(16_000);
    expect(pcm.length).toBe(16_000);
    for (const sample of pcm) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThanOrEqual(1);
    }
    // The synthesized 440Hz tone peaks near its 0.18 amplitude.
    const peak = Math.max(...Array.from(pcm).map((s) => Math.abs(s)));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(0.2);
  });

  it("throws on a non-RIFF buffer", () => {
    expect(() => decodePcm16Wav(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(
      /RIFF\/WAV/,
    );
  });

  it("throws on non-16-bit PCM", () => {
    const { wav } = makeDefaultAudioPayload();
    const mutated = Buffer.from(wav);
    mutated.writeUInt16LE(24, 34); // bitsPerSample -> 24
    expect(() => decodePcm16Wav(new Uint8Array(mutated))).toThrow(/16-bit/);
  });
});

describe("dataUrlToBytes", () => {
  it("parses a base64 PNG data URL", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const out = dataUrlToBytes(png);
    if (!out) throw new Error("expected PNG data URL to parse");
    expect(out.mimeType).toBe("image/png");
    // PNG magic number.
    expect(Array.from(out.bytes.subarray(0, 4))).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
  });

  it("parses a ;charset variant and keeps the mime type", () => {
    const dataUrl = "data:text/plain;charset=utf-8;base64,aGVsbG8=";
    const out = dataUrlToBytes(dataUrl);
    expect(out?.mimeType).toBe("text/plain");
    expect(out?.bytes.toString("utf8")).toBe("hello");
  });

  it("returns null on a malformed (non-base64) data URL", () => {
    expect(dataUrlToBytes("not-a-data-url")).toBeNull();
    expect(dataUrlToBytes("data:image/png,rawtext")).toBeNull();
  });
});

describe("readNumberArray", () => {
  it("clamps every sample into [-1, 1]", () => {
    expect(readNumberArray([2, -2, 0.5, -0.5])).toEqual([1, -1, 0.5, -0.5]);
  });

  it("rejects non-finite values and non-arrays", () => {
    expect(readNumberArray([0, Number.NaN])).toBeNull();
    expect(readNumberArray([0, Number.POSITIVE_INFINITY])).toBeNull();
    expect(readNumberArray("nope")).toBeNull();
    expect(readNumberArray([1, "2"])).toBeNull();
  });
});

describe("toPcmPayload", () => {
  it("builds a Float32 payload from valid samples + a positive rate", () => {
    const out = toPcmPayload({ pcmSamples: [0.1, -0.2], sampleRateHz: 16_000 });
    expect(out).not.toBeNull();
    expect(out?.sampleRateHz).toBe(16_000);
    expect(out?.pcm).toBeInstanceOf(Float32Array);
    expect(out?.pcm.length).toBe(2);
  });

  it("returns null without a positive sample rate or valid samples", () => {
    expect(toPcmPayload({ pcmSamples: [0.1], sampleRateHz: 0 })).toBeNull();
    expect(toPcmPayload({ pcmSamples: [0.1] })).toBeNull();
    expect(
      toPcmPayload({ pcmSamples: [Number.NaN], sampleRateHz: 16_000 }),
    ).toBeNull();
  });
});

describe("coerceText", () => {
  it("returns strings as-is, unwraps {text}, and JSON-stringifies others", () => {
    expect(coerceText("plain")).toBe("plain");
    expect(coerceText({ text: "wrapped" })).toBe("wrapped");
    expect(coerceText({ foo: 1 })).toBe(JSON.stringify({ foo: 1 }, null, 2));
  });
});

describe("detectVoiceActivity", () => {
  it("finds a segment for a sustained sine tone", () => {
    const sampleRate = 16_000;
    const samples = Array.from(
      { length: sampleRate },
      (_, i) => Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.18,
    );
    const result = detectVoiceActivity(samples, sampleRate);
    expect(result.segments.length).toBeGreaterThanOrEqual(1);
    expect(result.totalMs).toBe(1000);
    expect(result.peakRms).toBeGreaterThan(0);
    expect(result.frameCount).toBeGreaterThan(0);
  });

  it("finds no segment for pure silence", () => {
    const result = detectVoiceActivity(new Array(16_000).fill(0), 16_000);
    expect(result.segments).toHaveLength(0);
    expect(result.activeMs).toBe(0);
    expect(result.peakRms).toBe(0);
  });
});
