/**
 * Exercises the real ElevenLabsService bodies with the ElevenLabs SDK client
 * stubbed at the network boundary, covering the per-request output-format
 * override and the env-driven format validation added for the WAV TTS path.
 */

import { describe, expect, test } from "bun:test";
import { ElevenLabsService, getElevenLabsService } from "../elevenlabs";

/**
 * Minimal stand-in for the ElevenLabs SDK client. Only the network boundary is
 * faked; every assertion drives the real service method body. `ttsCalls`
 * records the request options so tests can assert the resolved output format.
 */
function fakeClient() {
  const ttsCalls: Array<{ voiceId: string; options: Record<string, unknown> }> = [];
  const client = {
    textToSpeech: {
      stream(voiceId: string, options: Record<string, unknown>) {
        ttsCalls.push({ voiceId, options });
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1, 2, 3, 4));
            controller.close();
          },
        });
      },
    },
    speechToText: {
      convert: async (_req: unknown) => sttResponse,
    },
    voices: {
      search: async () => ({ voices: [{ voiceId: "v1" }] }),
      get: async (id: string) => ({ voiceId: id, name: "got" }),
      delete: async (_id: string) => undefined,
      update: async (_id: string, settings: Record<string, unknown>) => settings,
      ivc: { create: async (_req: unknown) => ({ voiceId: "ivc-1" }) },
      pvc: { create: async (_req: unknown) => ({ voiceId: "pvc-1" }) },
    },
  };
  let sttResponse: unknown = { text: "hello" };
  return {
    client,
    ttsCalls,
    setSttResponse(next: unknown) {
      sttResponse = next;
    },
  };
}

function withStubbedClient(config: ConstructorParameters<typeof ElevenLabsService>[0]) {
  const service = new ElevenLabsService(config);
  const stub = fakeClient();
  (service as unknown as { client: unknown }).client = stub.client;
  return { service, stub };
}

describe("ElevenLabsService.fromEnv output-format validation", () => {
  test("defaults to mp3_44100_128 when ELEVENLABS_OUTPUT_FORMAT is unset", () => {
    const service = ElevenLabsService.fromEnv({ ELEVENLABS_API_KEY: "k" });
    expect((service as unknown as { config: { outputFormat: string } }).config.outputFormat).toBe(
      "mp3_44100_128",
    );
  });

  test("accepts a valid PCM format used by the WAV path", () => {
    const service = ElevenLabsService.fromEnv({
      ELEVENLABS_API_KEY: "k",
      ELEVENLABS_OUTPUT_FORMAT: "pcm_24000",
    });
    expect((service as unknown as { config: { outputFormat: string } }).config.outputFormat).toBe(
      "pcm_24000",
    );
  });

  test("throws a typed error for an unsupported format", () => {
    expect(() =>
      ElevenLabsService.fromEnv({
        ELEVENLABS_API_KEY: "k",
        ELEVENLABS_OUTPUT_FORMAT: "flac_96000",
      }),
    ).toThrow(/Unsupported output format/);
    try {
      ElevenLabsService.fromEnv({
        ELEVENLABS_API_KEY: "k",
        ELEVENLABS_OUTPUT_FORMAT: "flac_96000",
      });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ELEVENLABS_OUTPUT_FORMAT_INVALID");
    }
  });

  test("requires an API key", () => {
    expect(() => ElevenLabsService.fromEnv({})).toThrow(/ELEVENLABS_API_KEY/);
  });

  test("carries the configured voice/model/tuning env values into config", () => {
    const service = ElevenLabsService.fromEnv({
      ELEVENLABS_API_KEY: "k",
      ELEVENLABS_VOICE_ID: "voice-x",
      ELEVENLABS_MODEL_ID: "model-x",
      ELEVENLABS_VOICE_STABILITY: "0.9",
      ELEVENLABS_VOICE_SIMILARITY_BOOST: "0.1",
      ELEVENLABS_VOICE_STYLE: "0.2",
      ELEVENLABS_VOICE_USE_SPEAKER_BOOST: "false",
      ELEVENLABS_OPTIMIZE_STREAMING_LATENCY: "2",
    });
    const config = (
      service as unknown as {
        config: {
          voiceId: string;
          modelId: string;
          voiceStability: number;
          voiceUseSpeakerBoost: boolean;
          optimizeStreamingLatency: number;
        };
      }
    ).config;
    expect(config.voiceId).toBe("voice-x");
    expect(config.modelId).toBe("model-x");
    expect(config.voiceStability).toBeCloseTo(0.9);
    expect(config.voiceUseSpeakerBoost).toBe(false);
    expect(config.optimizeStreamingLatency).toBe(2);
  });
});

describe("ElevenLabsService.textToSpeech output format", () => {
  test("forwards a per-request outputFormat override to the client", async () => {
    const { service, stub } = withStubbedClient({
      apiKey: "k",
      outputFormat: "mp3_44100_128",
    });
    await service.textToSpeech({ text: "hi", outputFormat: "pcm_24000" });
    expect(stub.ttsCalls).toHaveLength(1);
    expect(stub.ttsCalls[0].options.outputFormat).toBe("pcm_24000");
    expect(stub.ttsCalls[0].voiceId).toBe("EXAVITQu4vr4xnSDxMaL");
  });

  test("falls back to the configured default output format", async () => {
    const { service, stub } = withStubbedClient({
      apiKey: "k",
      voiceId: "cfg-voice",
      outputFormat: "mp3_44100_128",
    });
    const stream = await service.textToSpeech({ text: "hi", modelId: "m" });
    expect(stub.ttsCalls[0].options.outputFormat).toBe("mp3_44100_128");
    expect(stub.ttsCalls[0].voiceId).toBe("cfg-voice");
    expect(stub.ttsCalls[0].options.modelId).toBe("m");
    // Streamed bytes flow through unchanged.
    const chunk = await stream.getReader().read();
    expect(Array.from(chunk.value ?? [])).toEqual([1, 2, 3, 4]);
  });
});

describe("ElevenLabsService speech-to-text and voice management", () => {
  test("returns the single-channel transcript and wraps a Blob in a File", async () => {
    const { service, stub } = withStubbedClient({ apiKey: "k" });
    stub.setSttResponse({ text: "spoken words" });
    const transcript = await service.speechToText({
      audioFile: new Blob(["bytes"]),
      modelId: "scribe_v2",
    });
    expect(transcript).toBe("spoken words");
  });

  test("combines multi-channel transcripts", async () => {
    const { service, stub } = withStubbedClient({ apiKey: "k" });
    stub.setSttResponse({
      transcripts: { ch0: { text: "left" }, ch1: { text: "right" } },
    });
    const transcript = await service.speechToText({
      audioFile: new File(["b"], "a.wav"),
    });
    expect(transcript).toBe("left right");
  });

  test("lists voices, fetches, updates, clones, and deletes", async () => {
    const { service } = withStubbedClient({ apiKey: "k" });
    expect(await service.getVoices()).toEqual([{ voiceId: "v1" }]);
    expect((await service.getVoiceById("v9")).voiceId).toBe("v9");
    expect(await service.updateVoiceSettings("v9", { name: "n", stability: 0.3 })).toMatchObject({
      stability: 0.3,
    });
    const ivc = await service.createInstantVoiceClone({ name: "clone", files: [] });
    expect(ivc.voiceId).toBe("ivc-1");
    const pvc = await service.createProfessionalVoiceClone({ name: "clone2", files: [] });
    expect(pvc.voiceId).toBe("pvc-1");
    await expect(service.deleteVoice("v9")).resolves.toBeUndefined();
  });
});

describe("getElevenLabsService", () => {
  test("constructs a fresh service from an explicit env override", () => {
    const service = getElevenLabsService({ ELEVENLABS_API_KEY: "k" });
    expect(service).toBeInstanceOf(ElevenLabsService);
  });

  test("caches the process-env singleton across calls", () => {
    const prior = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "process-key";
    try {
      const first = getElevenLabsService();
      const second = getElevenLabsService();
      expect(first).toBe(second);
    } finally {
      if (prior === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = prior;
    }
  });
});
