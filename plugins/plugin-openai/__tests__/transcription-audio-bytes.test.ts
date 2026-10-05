/**
 * `handleTranscription` in-process audio routing for core `TranscriptionParams`.
 *
 * Core requires an `audioUrl`, so callers that already hold the media send
 * `{ audioUrl: "", audio }` (audio redaction verification). The bytes must win
 * over the (possibly empty) URL instead of being sent to the URL fetcher.
 * An empty `audioUrl` with no bytes is a caller-shape error rejected at the
 * dispatch boundary, matching the elizacloud handler.
 * Deterministic with a stubbed provider endpoint; never touches the network.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordLlmCall: vi.fn(),
  fetchRemoteMedia: vi.fn(),
  uploaded: [] as Uint8Array[],
}));

vi.mock("@elizaos/core", async (importActual) => {
  const actual = await importActual<typeof import("@elizaos/core")>();
  return {
    ...actual,
    recordLlmCall: mocks.recordLlmCall,
    fetchRemoteMedia: (...args: unknown[]) => mocks.fetchRemoteMedia(...args),
  };
});

vi.mock("../utils/config", () => ({
  getAuthHeader: vi.fn(() => ({ Authorization: "Bearer test-key" })),
  getBaseURL: vi.fn(() => "https://api.openai.com/v1"),
  getTranscriptionModel: vi.fn(() => "gpt-4o-mini-transcribe"),
  getTTSInstructions: vi.fn(() => undefined),
  getTTSModel: vi.fn(() => "gpt-4o-mini-tts"),
  getTTSVoice: vi.fn(() => "nova"),
}));

import { handleTranscription } from "../models/audio";

function createRuntime(): IAgentRuntime {
  return {
    getSetting: vi.fn(() => null),
  } as unknown as IAgentRuntime;
}

// Minimal RIFF/WAVE header so mime auto-detection has real bytes to read.
const WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.uploaded.length = 0;
  mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) => fn());
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const form = init?.body as FormData;
    const file = form.get("file") as Blob;
    mocks.uploaded.push(new Uint8Array(await file.arrayBuffer()));
    return new Response(JSON.stringify({ text: "hello world" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI transcription in-process audio", () => {
  it.each([
    ["Uint8Array", WAV_BYTES],
    ["ArrayBuffer", WAV_BYTES.buffer as ArrayBuffer],
  ])("transcribes %s bytes sent beside the required empty audioUrl", async (_label, audio) => {
    const text = await handleTranscription(createRuntime(), {
      audioUrl: "",
      audio,
      mimeType: "audio/wav",
    });

    expect(text).toBe("hello world");
    expect(mocks.uploaded).toHaveLength(1);
    expect(mocks.uploaded[0]).toEqual(WAV_BYTES);
    expect(mocks.fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("posts exactly the viewed bytes of a nonzero-offset Uint8Array", async () => {
    const backing = new Uint8Array(7 + WAV_BYTES.byteLength + 5);
    backing.set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06], 0);
    backing.set(WAV_BYTES, 7);
    backing.set([0xf0, 0xf1, 0xf2, 0xf3, 0xf4], 7 + WAV_BYTES.byteLength);
    const offsetView = new Uint8Array(backing.buffer, 7, WAV_BYTES.byteLength);
    expect(offsetView.byteOffset).toBeGreaterThan(0);

    const text = await handleTranscription(createRuntime(), {
      audioUrl: "",
      audio: offsetView,
    });

    expect(text).toBe("hello world");
    expect(mocks.uploaded).toHaveLength(1);
    expect(mocks.uploaded[0]).toEqual(WAV_BYTES);
    expect(mocks.fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("rejects an empty audioUrl with no audio as a caller-shape error", async () => {
    await expect(handleTranscription(createRuntime(), { audioUrl: "" })).rejects.toThrow(
      "TRANSCRIPTION requires audio bytes or a non-empty audioUrl; received an empty audioUrl with no audio."
    );
    expect(mocks.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(mocks.uploaded).toHaveLength(0);
  });
});
