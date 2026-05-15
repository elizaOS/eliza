import { describe, expect, it } from "vitest";

import {
  KokoroMockRuntime,
  type KokoroEngineDiscoveryResult,
} from "@elizaos/shared/local-inference";
import { makeKokoroTextToSpeechHandler } from "../src/aosp-local-inference-bootstrap";

function kokoroDiscovery(): KokoroEngineDiscoveryResult {
  return {
    runtimeKind: "onnx",
    defaultVoiceId: "af_bella",
    layout: {
      root: "/tmp/kokoro",
      modelFile: "model.onnx",
      voicesDir: "/tmp/kokoro/voices",
      sampleRate: 24_000,
    },
  };
}

describe("AOSP Kokoro TEXT_TO_SPEECH handler", () => {
  it("synthesizes shared Kokoro output as WAV bytes", async () => {
    const handler = makeKokoroTextToSpeechHandler({
      discover: kokoroDiscovery,
      runtime: new KokoroMockRuntime({
        sampleRate: 24_000,
        totalSamples: 240,
        chunkCount: 2,
      }),
    });

    const wav = await handler({} as never, { text: "Hello from Android." });
    const header = String.fromCharCode(...wav.subarray(0, 12));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(header.slice(0, 4)).toBe("RIFF");
    expect(header.slice(8, 12)).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(480);
    expect(wav.byteLength).toBe(44 + 480);
  });

  it("fails clearly when Kokoro artifacts are not staged", async () => {
    const handler = makeKokoroTextToSpeechHandler({
      discover: () => null,
    });

    await expect(handler({} as never, "hello")).rejects.toThrow(
      /Kokoro TEXT_TO_SPEECH is not available/,
    );
  });

  it("observes request abort signals", async () => {
    const controller = new AbortController();
    const handler = makeKokoroTextToSpeechHandler({
      discover: kokoroDiscovery,
      runtime: new KokoroMockRuntime({
        sampleRate: 24_000,
        totalSamples: 24_000,
        chunkCount: 8,
      }),
    });

    controller.abort();

    await expect(
      handler({} as never, {
        text: "This request was cancelled before synthesis.",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
