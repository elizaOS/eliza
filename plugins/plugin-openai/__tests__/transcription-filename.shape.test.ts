/**
 * Regression tests for the TRANSCRIPTION multipart upload filename. The Node
 * URL path wraps remote bytes in a Blob whose type is the server's raw
 * `audio/*` Content-Type, which can be a valid-but-non-canonical alias
 * (`audio/mp3`, `audio/x-wav`, `audio/aac`). Previously the handler cast that
 * string straight to `AudioMimeType` and derived `recording.undefined`, which
 * OpenAI's /audio/transcriptions rejects (HTTP 400, unrecognized extension).
 * The handler is exercised through its real code path with the guarded Node
 * fetcher installed; only config, `recordLlmCall`, `fetchRemoteMedia`, and the
 * global `fetch` are mocked, so no live model or network is required. The pure
 * `normalizeAudioMimeType` / `getExtensionForMimeType` mapping is asserted
 * directly for the alias table and unknown inputs.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getExtensionForMimeType,
  getFilenameForMimeType,
  normalizeAudioMimeType,
} from "../utils/audio";

const mocks = vi.hoisted(() => ({
  recordLlmCall: vi.fn(),
  fetchRemoteMedia: vi.fn(),
  getAuthHeader: vi.fn(() => ({ Authorization: "Bearer test-key" })),
  getBaseURL: vi.fn(() => "https://api.openai.com/v1"),
  getTranscriptionModel: vi.fn(() => "gpt-4o-mini-transcribe"),
}));

const coreMockFactory = vi.hoisted(
  () => async (importActual: () => Promise<Record<string, unknown>>) => {
    const actual = await importActual();
    return {
      ...actual,
      logger: { debug: vi.fn(), error: vi.fn(), log: vi.fn(), warn: vi.fn() },
      recordLlmCall: mocks.recordLlmCall,
      fetchRemoteMedia: (...args: unknown[]) => mocks.fetchRemoteMedia(...args),
    };
  }
);

vi.mock("@elizaos/core", coreMockFactory);
vi.mock("@elizaos/core/node", coreMockFactory);

vi.mock("../utils/config", () => ({
  getAuthHeader: mocks.getAuthHeader,
  getBaseURL: mocks.getBaseURL,
  getTranscriptionModel: mocks.getTranscriptionModel,
  getTTSInstructions: vi.fn(() => undefined),
  getTTSModel: vi.fn(() => "gpt-4o-mini-tts"),
  getTTSVoice: vi.fn(() => "nova"),
}));

import { handleTranscription } from "../models/audio";
import { installNodeTranscriptionUrlFetcher } from "../models/transcription-url.node";

installNodeTranscriptionUrlFetcher();

// OpenAI /audio/transcriptions determines the audio format from the filename
// extension and 400s on anything outside this set; the derived name must land
// inside it for every accepted alias.
const RECOGNIZED_EXTENSIONS = new Set([
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "oga",
  "ogg",
  "wav",
  "webm",
]);

// ID3-tagged MP3 (real magic bytes) so container sniffing is authoritative.
const MP3_ID3_BYTES = Buffer.from([
  0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00,
]);
// Minimal RIFF/WAVE header (real magic bytes).
const WAV_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
]);
// AAC-in-a-CDN blob whose bytes do NOT match any sniffer signature, so the
// handler must fall back to normalizing the declared `audio/aac` header.
const OPAQUE_AAC_BYTES = Buffer.from([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
]);

function createRuntime(): IAgentRuntime {
  return { getSetting: vi.fn(() => null) } as unknown as IAgentRuntime;
}

async function captureUploadFilename(contentType: string, buffer: Buffer): Promise<string> {
  mocks.fetchRemoteMedia.mockResolvedValue({ buffer, contentType, fileName: null });
  let capturedFilename = "";
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const formData = init.body as FormData;
    const file = formData.get("file") as File;
    capturedFilename = file.name;
    return new Response(JSON.stringify({ text: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
  await handleTranscription(createRuntime(), "https://cdn.example.com/voice");
  return capturedFilename;
}

describe("TRANSCRIPTION upload filename for non-canonical audio content types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) => fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { contentType: "audio/mp3", buffer: MP3_ID3_BYTES, expected: "recording.mp3" },
    { contentType: "audio/x-wav", buffer: WAV_BYTES, expected: "recording.wav" },
    { contentType: "audio/wave", buffer: WAV_BYTES, expected: "recording.wav" },
    { contentType: "audio/aac", buffer: OPAQUE_AAC_BYTES, expected: "recording.m4a" },
    { contentType: "audio/x-m4a", buffer: OPAQUE_AAC_BYTES, expected: "recording.m4a" },
  ])(
    "uploads a recognized extension for Content-Type $contentType",
    async ({ contentType, buffer, expected }) => {
      const filename = await captureUploadFilename(contentType, buffer);

      expect(filename).not.toContain("undefined");
      expect(filename).toBe(expected);
      const ext = filename.split(".").pop() ?? "";
      expect(RECOGNIZED_EXTENSIONS.has(ext)).toBe(true);
    }
  );

  it("prefers sniffed container over a mislabeled non-canonical header", async () => {
    // Bytes are a real MP3 but the CDN mislabeled them audio/x-wav; the sniffer
    // wins so OpenAI receives the correct .mp3 format hint.
    const filename = await captureUploadFilename("audio/x-wav", MP3_ID3_BYTES);
    expect(filename).toBe("recording.mp3");
  });
});

describe("normalizeAudioMimeType alias mapping", () => {
  it.each([
    ["audio/mp3", "audio/mpeg", "mp3"],
    ["audio/mpeg", "audio/mpeg", "mp3"],
    ["audio/x-wav", "audio/wav", "wav"],
    ["audio/wave", "audio/wav", "wav"],
    ["audio/x-m4a", "audio/mp4", "m4a"],
    ["audio/aac", "audio/mp4", "m4a"],
    ["audio/opus", "audio/ogg", "ogg"],
    ["audio/x-flac", "audio/flac", "flac"],
    ["AUDIO/MP3; codecs=mp3", "audio/mpeg", "mp3"],
  ] as const)("maps %s to canonical %s", (raw, canonical, extension) => {
    const normalized = normalizeAudioMimeType(raw);
    expect(normalized).toBe(canonical);
    expect(getExtensionForMimeType(normalized)).toBe(extension);
    expect(getFilenameForMimeType(normalized)).toBe(`recording.${extension}`);
  });

  it.each(["application/pdf", "text/plain", "", "not-a-mime", null, undefined])(
    "collapses unrecognized input %s to application/octet-stream (recording.bin)",
    (raw) => {
      const normalized = normalizeAudioMimeType(raw);
      expect(normalized).toBe("application/octet-stream");
      expect(getFilenameForMimeType(normalized)).toBe("recording.bin");
      expect(getFilenameForMimeType(normalized)).not.toContain("undefined");
    }
  );
});
