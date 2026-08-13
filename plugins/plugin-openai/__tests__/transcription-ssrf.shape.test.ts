/**
 * Unit tests for TRANSCRIPTION audio-URL loading: SSRF fail-closed private
 * hosts via real `fetchRemoteMedia`, plus the happy path that posts guarded
 * bytes to the provider. Config and `recordLlmCall` are mocked; no live model
 * or public network is required for the blocked-URL cases.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordLlmCall: vi.fn(),
  fetchRemoteMedia: vi.fn(),
  getAuthHeader: vi.fn(() => ({ Authorization: "Bearer test-key" })),
  getBaseURL: vi.fn(() => "https://api.openai.com/v1"),
  getTranscriptionModel: vi.fn(() => "gpt-4o-mini-transcribe"),
  useRealFetchRemoteMedia: false,
  realFetchRemoteMedia: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

// The handler imports logger/recordLlmCall from `@elizaos/core`; the Node
// URL fetcher (models/transcription-url.node.ts) loads `fetchRemoteMedia`
// lazily from `@elizaos/core/node` so the browser bundle never pulls it in.
// Under Node both specifiers resolve to the same module file, so both mocks
// must expose the same full mocked surface.
const coreMockFactory = vi.hoisted(
  () => async (importActual: () => Promise<Record<string, unknown>>) => {
    const actual = await importActual();
    mocks.realFetchRemoteMedia = actual.fetchRemoteMedia as (
      ...args: unknown[]
    ) => Promise<unknown>;
    return {
      ...actual,
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
        warn: vi.fn(),
      },
      recordLlmCall: mocks.recordLlmCall,
      fetchRemoteMedia: (...args: unknown[]) => {
        if (mocks.useRealFetchRemoteMedia && mocks.realFetchRemoteMedia) {
          return mocks.realFetchRemoteMedia(...args);
        }
        return mocks.fetchRemoteMedia(...args);
      },
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

// The Node entrypoint installs this in production; tests import models
// directly, so install the same guarded fetcher here.
installNodeTranscriptionUrlFetcher();

function createRuntime(): IAgentRuntime {
  return {
    getSetting: vi.fn(() => null),
  } as unknown as IAgentRuntime;
}

describe("OpenAI transcription SSRF policy (real fetchRemoteMedia)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useRealFetchRemoteMedia = true;
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) => fn());
  });

  afterEach(() => {
    mocks.useRealFetchRemoteMedia = false;
    vi.unstubAllGlobals();
  });

  it.each([
    "http://127.0.0.1/secret.wav",
    "http://[::1]/secret.wav",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/internal.wav",
    "http://10.0.0.5/intranet.wav",
    "http://192.168.1.1/router.wav",
  ])("fails closed for blocked audio URL %s without calling the provider", async (url) => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(handleTranscription(createRuntime(), url)).rejects.toThrow(
      /Failed to fetch media|not allowed|blocked|private|loopback|link-local|Invalid URL|SSRF/i
    );
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty URL strings before any fetch", async () => {
    mocks.useRealFetchRemoteMedia = false;
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(handleTranscription(createRuntime(), "   ")).rejects.toThrow(
      "TRANSCRIPTION requires a valid audio URL"
    );
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
    expect(mocks.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OpenAI transcription audio URL happy path (mocked remote media)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useRealFetchRemoteMedia = false;
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) => fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads audio through fetchRemoteMedia bounds then posts to the provider", async () => {
    const audioBytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74,
      0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58,
      0x01, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
    ]);
    mocks.fetchRemoteMedia.mockResolvedValue({
      buffer: audioBytes,
      contentType: "audio/wav",
      fileName: "sample.wav",
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "hello world" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const text = await handleTranscription(createRuntime(), "https://cdn.example.com/sample.wav");

    expect(text).toBe("hello world");
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.example.com/sample.wav",
        maxBytes: 25 * 1024 * 1024,
        timeoutMs: 30_000,
        maxRedirects: 5,
      })
    );
    expect(mocks.recordLlmCall).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [providerUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(providerUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("loads CoreTranscriptionParams.audioUrl through the same SSRF media guard", async () => {
    mocks.fetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from([1, 2, 3, 4]),
      contentType: "audio/webm",
      fileName: "clip.webm",
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "from params" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const text = await handleTranscription(createRuntime(), {
      audioUrl: "https://cdn.example.com/clip.webm",
      prompt: "focus on speech",
    });

    expect(text).toBe("from params");
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.example.com/clip.webm",
        maxBytes: 25 * 1024 * 1024,
      })
    );
  });
});
