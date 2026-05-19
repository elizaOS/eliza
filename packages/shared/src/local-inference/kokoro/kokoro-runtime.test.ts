import { describe, expect, it } from "vitest";

import { KokoroGgufRuntime, KokoroMockRuntime } from "./kokoro-runtime.js";
import type { KokoroVoicePack } from "./types.js";

function makeVoice(): KokoroVoicePack {
  return {
    id: "af_test",
    displayName: "Test",
    lang: "a",
    file: "af_test.bin",
    dim: 4,
    tags: ["test"],
  };
}

describe("KokoroMockRuntime", () => {
  it("emits chunks and a final marker", async () => {
    const runtime = new KokoroMockRuntime({
      sampleRate: 24_000,
      totalSamples: 100,
      chunkCount: 4,
    });
    const chunks: Array<{ isFinal: boolean; len: number }> = [];
    await runtime.synthesize({
      phonemes: { ids: Int32Array.from([1, 2, 3]), phonemes: "abc" },
      voice: makeVoice(),
      cancelSignal: { cancelled: false },
      onChunk: (c) => {
        chunks.push({ isFinal: c.isFinal, len: c.pcm.length });
        return undefined;
      },
    });
    expect(chunks.at(-1)?.isFinal).toBe(true);
    const bodyChunks = chunks.filter((c) => !c.isFinal);
    expect(bodyChunks.length).toBeGreaterThan(0);
    const total = bodyChunks.reduce((s, c) => s + c.len, 0);
    expect(total).toBe(100);
  });

  it("increments calls counter", async () => {
    const runtime = new KokoroMockRuntime({ sampleRate: 24_000 });
    expect(runtime.calls).toBe(0);
    await runtime.synthesize({
      phonemes: { ids: Int32Array.from([1]), phonemes: "a" },
      voice: makeVoice(),
      cancelSignal: { cancelled: false },
      onChunk: () => undefined,
    });
    expect(runtime.calls).toBe(1);
  });
});

describe("KokoroGgufRuntime", () => {
  it("throws when server returns a non-ok response", async () => {
    const runtime = new KokoroGgufRuntime({
      serverUrl: "http://127.0.0.1:18789",
      modelId: "kokoro-v1.0",
      sampleRate: 24_000,
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          body: null,
        }) as unknown as Response) as unknown as typeof fetch,
    });
    await expect(
      runtime.synthesize({
        phonemes: { ids: Int32Array.from([1, 2]), phonemes: "ab" },
        voice: makeVoice(),
        cancelSignal: { cancelled: false },
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("503");
  });

  it("dispose is a no-op (stateless adapter)", () => {
    const runtime = new KokoroGgufRuntime({
      serverUrl: "http://127.0.0.1:18789",
      modelId: "kokoro-v1.0",
      sampleRate: 24_000,
    });
    expect(() => runtime.dispose()).not.toThrow();
  });
});
