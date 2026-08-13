/**
 * Unit tests for the browser transcription-URL boundary (#18702): literal
 * private/loopback/link-local/metadata hosts fail closed before any network
 * call, redirects are refused before any hop request is issued, a response
 * with no final URL fails closed, the shared byte cap is enforced, the
 * handler works with no `Buffer` global, and the happy path reaches the
 * guarded fetch → provider flow. Config and `recordLlmCall` are mocked; the
 * transport is a stubbed global fetch — deterministic, no live network.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { SsrfBlockedError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordLlmCall: vi.fn(),
  getAuthHeader: vi.fn(() => ({ Authorization: "Bearer test-key" })),
  getBaseURL: vi.fn(() => "https://api.openai.com/v1"),
  getTranscriptionModel: vi.fn(() => "gpt-4o-mini-transcribe"),
}));

vi.mock("@elizaos/core", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    },
    recordLlmCall: mocks.recordLlmCall,
  };
});

vi.mock("../utils/config", () => ({
  getAuthHeader: mocks.getAuthHeader,
  getBaseURL: mocks.getBaseURL,
  getTranscriptionModel: mocks.getTranscriptionModel,
  getTTSInstructions: vi.fn(() => undefined),
  getTTSModel: vi.fn(() => "gpt-4o-mini-tts"),
  getTTSVoice: vi.fn(() => "nova"),
}));

import { handleTranscription } from "../models/audio";
import { TRANSCRIPTION_AUDIO_MAX_BYTES } from "../models/transcription-url";
import { installBrowserTranscriptionUrlFetcher } from "../models/transcription-url.browser";

// The browser entrypoint installs this in production; tests import models
// directly, so install the same guarded fetcher here.
installBrowserTranscriptionUrlFetcher();

const WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

function createRuntime(): IAgentRuntime {
  return {
    getSetting: vi.fn(() => null),
  } as unknown as IAgentRuntime;
}

/** `new Response()` leaves `url` as "" — give mocks the final URL a real fetch exposes. */
function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("browser transcription URL boundary fails closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) => fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "http://127.0.0.1/secret.wav",
    "http://[::1]/secret.wav",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/internal.wav",
    "http://10.0.0.5/intranet.wav",
    "http://192.168.1.1/router.wav",
    "ftp://cdn.example.com/sample.wav",
  ])("blocks %s before any network call", async (url) => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(handleTranscription(createRuntime(), url)).rejects.toThrow(
      /Blocked|Invalid audio URL/i
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("rejects empty URL strings before any fetch", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(handleTranscription(createRuntime(), "   ")).rejects.toThrow(
      "TRANSCRIPTION requires a valid audio URL"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("refuses redirects before any hop request can be issued", async () => {
    const requested: string[] = [];
    const privateTarget = "http://169.254.169.254/latest/meta-data/";
    // Emulates the Fetch Standard: the platform performs the redirect hop
    // internally before fetch() resolves unless redirect is "error"/"manual",
    // so a mode of "follow" means the hop request has already been sent.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      if (init?.redirect === "follow") {
        requested.push(privateTarget);
        const landed = new Response(WAV_BYTES, {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        });
        return withUrl(landed, privateTarget);
      }
      throw new TypeError("Failed to fetch: unexpected redirect");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleTranscription(createRuntime(), "https://cdn.example.com/redirects.wav")
    ).rejects.toThrow();
    expect(requested).toEqual(["https://cdn.example.com/redirects.wav"]);
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("blocks a response that lands on a private host without posting to the provider", async () => {
    const landed = new Response(WAV_BYTES, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    });
    Object.defineProperty(landed, "url", { value: "http://192.168.1.10/loot.wav" });
    const fetchMock = vi.fn(async () => landed);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleTranscription(createRuntime(), "https://cdn.example.com/redirects.wav")
    ).rejects.toThrow(/Blocked audio redirect target host/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("fails closed when the response exposes no final URL", async () => {
    // A WhatWG `new Response(bytes)` (and some polyfills) leaves `url` as "".
    const anonymous = new Response(WAV_BYTES, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    });
    const cancelSpy = vi.spyOn(anonymous.body as ReadableStream<Uint8Array>, "cancel");
    const fetchMock = vi.fn(async () => anonymous);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleTranscription(createRuntime(), "https://cdn.example.com/anonymous.wav")
    ).rejects.toThrow(SsrfBlockedError);
    expect(cancelSpy).toHaveBeenCalled();
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("rejects a declared content length over the shared byte cap", async () => {
    const oversized = withUrl(
      new Response(WAV_BYTES, {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": String(TRANSCRIPTION_AUDIO_MAX_BYTES + 1),
        },
      }),
      "https://cdn.example.com/huge.wav"
    );
    const fetchMock = vi.fn(async () => oversized);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleTranscription(createRuntime(), "https://cdn.example.com/huge.wav")
    ).rejects.toThrow(/exceeds maxBytes/);
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("rejects a streamed body that exceeds the byte cap without a content length", async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > TRANSCRIPTION_AUDIO_MAX_BYTES) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const fetchMock = vi.fn(async () =>
      withUrl(
        new Response(body, { status: 200, headers: { "Content-Type": "audio/wav" } }),
        "https://cdn.example.com/unbounded.wav"
      )
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleTranscription(createRuntime(), "https://cdn.example.com/unbounded.wav")
    ).rejects.toThrow(/exceeds maxBytes/);
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });
});

describe("browser transcription URL happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) => fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches allowed audio URLs through the guard then posts to the provider", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://cdn.example.com/sample.wav") {
        return withUrl(
          new Response(WAV_BYTES, {
            status: 200,
            headers: { "Content-Type": "audio/wav" },
          }),
          url
        );
      }
      return new Response(JSON.stringify({ text: "hello from browser" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const text = await handleTranscription(createRuntime(), "https://cdn.example.com/sample.wav");

    expect(text).toBe("hello from browser");
    expect(mocks.recordLlmCall).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [providerUrl, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(providerUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const file = (init.body as FormData).get("file") as File;
    expect(file.type).toBe("audio/wav");
  });

  it("loads CoreTranscriptionParams.audioUrl through the same browser guard", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://cdn.example.com/clip.wav") {
        return withUrl(
          new Response(WAV_BYTES, {
            status: 200,
            headers: { "Content-Type": "audio/wav" },
          }),
          url
        );
      }
      return new Response(JSON.stringify({ text: "from params" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const text = await handleTranscription(createRuntime(), {
      audioUrl: "https://cdn.example.com/clip.wav",
      prompt: "focus on speech",
    });

    expect(text).toBe("from params");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles CoreTranscriptionParams.audioUrl with no Buffer global (browser runtime)", async () => {
    // Plain-object responses: Node's undici Response internals use the Buffer
    // global this test removes, and the SUT is the handler chain, not undici.
    const audioResponse = {
      url: "https://cdn.example.com/clip.wav",
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "audio/wav" }),
      body: null,
      arrayBuffer: async () => WAV_BYTES.slice().buffer,
    } as unknown as Response;
    const providerResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ text: "no buffer needed" }),
    } as unknown as Response;
    // A real browser never defines Buffer; the input classification chain must
    // not reference it bare (it previously threw before reaching audioUrl).
    vi.stubGlobal("Buffer", undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "https://cdn.example.com/clip.wav" ? audioResponse : providerResponse
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const text = await handleTranscription(createRuntime(), {
      audioUrl: "https://cdn.example.com/clip.wav",
    });

    expect(text).toBe("no buffer needed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
