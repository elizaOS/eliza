/**
 * `handleTranscription` in-process audio routing: `{ audioUrl: "", audio }`
 * (the shape core requires of byte-holding callers such as audio redaction
 * verification) transcribes the bytes without fetching the empty URL.
 * Deterministic with a stubbed Cloud STT endpoint; never touches the network.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTranscription } from "./transcription";

const state = vi.hoisted(() => ({
  uploaded: [] as Uint8Array[],
  fetchCalls: 0,
}));

vi.mock("../utils/sdk-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/sdk-client")>();
  return {
    ...actual,
    createElizaCloudClient: () => ({
      routes: {
        postApiV1VoiceSttRaw: async (args: { body: FormData }) => {
          const audio = args.body.get("audio");
          state.uploaded.push(
            new Uint8Array(await (audio as Blob).arrayBuffer())
          );
          return Response.json({ text: "hello world" });
        },
      },
    }),
  };
});

function runtime(): IAgentRuntime {
  return {
    getSetting: (key: string) => process.env[key],
  } as unknown as IAgentRuntime;
}

// Minimal RIFF/WAVE header so mime auto-detection has real bytes to read.
const WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
]);

beforeEach(() => {
  state.uploaded.length = 0;
  state.fetchCalls = 0;
  vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "test-cloud-key");
  vi.stubEnv("ELIZAOS_CLOUD_ENABLED", "true");
  vi.stubGlobal("fetch", (..._args: unknown[]) => {
    state.fetchCalls += 1;
    throw new Error("network fetch must not be called for in-process audio");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("handleTranscription in-process audio", () => {
  it.each([
    ["Uint8Array", WAV_BYTES],
    ["ArrayBuffer", WAV_BYTES.buffer as ArrayBuffer],
  ])(
    "transcribes %s bytes sent beside the required empty audioUrl",
    async (_label, audio) => {
      const text = await handleTranscription(runtime(), {
        audioUrl: "",
        audio,
        mimeType: "audio/wav",
      });

      expect(text).toBe("hello world");
      expect(state.uploaded).toHaveLength(1);
      expect(state.uploaded[0]).toEqual(WAV_BYTES);
      expect(state.fetchCalls).toBe(0);
    }
  );

  it("posts exactly the viewed bytes of a nonzero-offset Uint8Array", async () => {
    // A byte-holding caller may hand over a view into a larger decode buffer.
    // Only the viewed bytes may reach Cloud STT; surrounding backing bytes
    // must not leak into the upload (and no mimeType is passed, so header
    // auto-detection also runs on the derived bytes).
    const backing = new Uint8Array(7 + WAV_BYTES.byteLength + 5);
    backing.set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06], 0);
    backing.set(WAV_BYTES, 7);
    backing.set([0xf0, 0xf1, 0xf2, 0xf3, 0xf4], 7 + WAV_BYTES.byteLength);
    const offsetView = new Uint8Array(
      backing.buffer,
      7,
      WAV_BYTES.byteLength
    );
    expect(offsetView.byteOffset).toBeGreaterThan(0);

    const text = await handleTranscription(runtime(), {
      audioUrl: "",
      audio: offsetView,
    });

    expect(text).toBe("hello world");
    expect(state.uploaded).toHaveLength(1);
    expect(state.uploaded[0]).toEqual(WAV_BYTES);
    expect(state.fetchCalls).toBe(0);
  });

  it("rejects an empty audioUrl with no audio instead of fetching it", async () => {
    await expect(
      handleTranscription(runtime(), { audioUrl: "" })
    ).rejects.toThrow(/empty audioUrl/);
    expect(state.uploaded).toHaveLength(0);
    expect(state.fetchCalls).toBe(0);
  });
});
