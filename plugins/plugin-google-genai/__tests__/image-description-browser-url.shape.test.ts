/**
 * Unit tests for the browser image-URL boundary (#18699): literal
 * private/loopback/link-local/metadata hosts fail closed before any network
 * call, redirects are refused before any hop request is issued, a response
 * with no final URL fails closed, the shared byte cap is enforced, and the
 * happy path reaches the guarded fetch → provider flow with the fetched
 * bytes inlined as base64. Config, tokenization, and
 * `recordLlmCall` are mocked; the transport is a stubbed global fetch —
 * deterministic, no live network.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGoogleGenAI: vi.fn(),
  generateContent: vi.fn(),
  countTokens: vi.fn(),
  recordLlmCall: vi.fn(),
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
  createGoogleGenAI: mocks.createGoogleGenAI,
  getImageModel: vi.fn(() => "gemini-2.0-flash"),
  getSafetySettings: vi.fn(() => []),
}));

vi.mock("../utils/tokenization", () => ({
  countTokens: mocks.countTokens,
}));

import { SsrfBlockedError } from "@elizaos/core";
import { handleImageDescription } from "../models/image";
import { IMAGE_DESCRIPTION_MAX_BYTES } from "../models/image-url";
import { installBrowserImageUrlFetcher } from "../models/image-url.browser";

// The browser entrypoint installs this in production; tests import models
// directly, so install the same guarded fetcher here.
installBrowserImageUrlFetcher();

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
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

function mockModelOk() {
  mocks.createGoogleGenAI.mockReturnValue({
    models: { generateContent: mocks.generateContent },
  });
  mocks.generateContent.mockResolvedValue({
    text: JSON.stringify({ title: "A cat", description: "A ginger cat." }),
  });
}

describe("browser image URL boundary fails closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countTokens.mockResolvedValue(5);
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) =>
      fn(),
    );
    mockModelOk();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "http://127.0.0.1/secret.png",
    "http://[::1]/secret.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/internal.png",
    "http://10.0.0.5/intranet.png",
    "http://192.168.1.1/router.png",
    "ftp://cdn.example.com/sample.png",
  ])("blocks %s before any network call", async (url) => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(handleImageDescription(createRuntime(), url)).rejects.toThrow(
      /Blocked|Invalid image URL/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("rejects empty URL strings before any fetch", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleImageDescription(createRuntime(), "   "),
    ).rejects.toThrow("IMAGE_DESCRIPTION requires a valid image URL");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("refuses redirects before any hop request can be issued", async () => {
    const requested: string[] = [];
    const privateTarget = "http://169.254.169.254/latest/meta-data/";
    // Emulates the Fetch Standard: the platform performs the redirect hop
    // internally before fetch() resolves unless redirect is "error"/"manual",
    // so a mode of "follow" means the hop request has already been sent.
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requested.push(String(input));
        if (init?.redirect === "follow") {
          requested.push(privateTarget);
          const landed = new Response(PNG_BYTES, {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
          return withUrl(landed, privateTarget);
        }
        throw new TypeError("Failed to fetch: unexpected redirect");
      },
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleImageDescription(
        createRuntime(),
        "https://cdn.example.com/redirects.png",
      ),
    ).rejects.toThrow();
    expect(requested).toEqual(["https://cdn.example.com/redirects.png"]);
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("blocks a response that lands on a private host without calling the model", async () => {
    const landed = new Response(PNG_BYTES, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
    Object.defineProperty(landed, "url", {
      value: "http://192.168.1.10/loot.png",
    });
    const fetchMock = vi.fn(async () => landed);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleImageDescription(
        createRuntime(),
        "https://cdn.example.com/redirects.png",
      ),
    ).rejects.toThrow(/Blocked image redirect target host/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("fails closed when the response exposes no final URL", async () => {
    // A WhatWG `new Response(bytes)` (and some polyfills) leaves `url` as "".
    const anonymous = new Response(PNG_BYTES, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
    const cancelSpy = vi.spyOn(
      anonymous.body as ReadableStream<Uint8Array>,
      "cancel",
    );
    const fetchMock = vi.fn(async () => anonymous);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleImageDescription(
        createRuntime(),
        "https://cdn.example.com/anonymous.png",
      ),
    ).rejects.toThrow(SsrfBlockedError);
    expect(cancelSpy).toHaveBeenCalled();
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("rejects a declared content length over the shared byte cap", async () => {
    const oversized = withUrl(
      new Response(PNG_BYTES, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(IMAGE_DESCRIPTION_MAX_BYTES + 1),
        },
      }),
      "https://cdn.example.com/huge.png",
    );
    const fetchMock = vi.fn(async () => oversized);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleImageDescription(
        createRuntime(),
        "https://cdn.example.com/huge.png",
      ),
    ).rejects.toThrow(/exceeds maxBytes/);
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("rejects a streamed body that exceeds the byte cap without a content length", async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > IMAGE_DESCRIPTION_MAX_BYTES) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const fetchMock = vi.fn(async () =>
      withUrl(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
        "https://cdn.example.com/unbounded.png",
      ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleImageDescription(
        createRuntime(),
        "https://cdn.example.com/unbounded.png",
      ),
    ).rejects.toThrow(/exceeds maxBytes/);
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });

  it("throws on HTTP errors without calling the model", async () => {
    const fetchMock = vi.fn(async () =>
      withUrl(
        new Response("nope", { status: 404, statusText: "Not Found" }),
        "https://cdn.example.com/missing.png",
      ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      handleImageDescription(
        createRuntime(),
        "https://cdn.example.com/missing.png",
      ),
    ).rejects.toThrow(/HTTP 404/);
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.recordLlmCall).not.toHaveBeenCalled();
  });
});

describe("browser image URL happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countTokens.mockResolvedValue(5);
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) =>
      fn(),
    );
    mockModelOk();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches allowed image URLs through the guard then inlines them for the model", async () => {
    const fetchMock = vi.fn(async () =>
      withUrl(
        new Response(PNG_BYTES, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
        "https://cdn.example.com/cat.png",
      ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const result = await handleImageDescription(
      createRuntime(),
      "https://cdn.example.com/cat.png",
    );

    expect(result).toEqual({ title: "A cat", description: "A ginger cat." });
    // One transport call for the image; the provider call is the mocked
    // Gemini client, not fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.recordLlmCall).toHaveBeenCalledTimes(1);
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    const request = mocks.generateContent.mock.calls[0]?.[0] as {
      contents: Array<{
        parts: Array<{ inlineData?: { mimeType: string; data: string } }>;
      }>;
    };
    const inline = request.contents[0]?.parts[1]?.inlineData;
    expect(inline?.mimeType).toBe("image/png");
    expect(inline?.data).toBe(Buffer.from(PNG_BYTES).toString("base64"));
  });
});
