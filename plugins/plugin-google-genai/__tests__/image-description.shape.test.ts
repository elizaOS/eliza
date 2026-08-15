/**
 * Unit tests for `handleImageDescription`: the JSON and prose parse paths plus
 * the failure paths that must surface as typed errors instead of a fabricated
 * `{ title, description }` result — uninitialized client, image fetch failure,
 * SSRF-blocked private hosts, provider (`generateContent`) rejection, and an
 * empty model completion. Config, tokenization, `recordLlmCall`, and
 * `fetchRemoteMedia` are mocked; no live model or network call is made.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGoogleGenAI: vi.fn(),
  generateContent: vi.fn(),
  countTokens: vi.fn(),
  recordLlmCall: vi.fn(),
  fetchRemoteMedia: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@elizaos/core", () => ({
  logger: mocks.logger,
  recordLlmCall: mocks.recordLlmCall,
}));

// The handler imports logger/recordLlmCall from `@elizaos/core`; the Node
// URL fetcher (models/image-url.node.ts) loads `fetchRemoteMedia` lazily from
// `@elizaos/core/node` so the browser bundle never pulls it in. Under Node
// both specifiers resolve to the same module file, so both mocks must expose
// the same full mocked surface.
vi.mock("@elizaos/core/node", () => ({
  fetchRemoteMedia: mocks.fetchRemoteMedia,
  logger: mocks.logger,
  recordLlmCall: mocks.recordLlmCall,
}));

vi.mock("../utils/config", () => ({
  createGoogleGenAI: mocks.createGoogleGenAI,
  getImageModel: vi.fn(() => "gemini-2.0-flash"),
  getSafetySettings: vi.fn(() => []),
}));

vi.mock("../utils/tokenization", () => ({
  countTokens: mocks.countTokens,
}));

import { handleImageDescription } from "../models/image";
import { installNodeImageUrlFetcher } from "../models/image-url.node";

// The Node entrypoint installs this in production; tests import models
// directly, so install the same guarded fetcher here.
installNodeImageUrlFetcher();

function createRuntime(): IAgentRuntime {
  return {
    getSetting: vi.fn(() => null),
  } as unknown as IAgentRuntime;
}

function mockMediaOk(contentType = "image/png") {
  mocks.fetchRemoteMedia.mockResolvedValue({
    buffer: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    contentType,
    fileName: "cat.png",
  });
}

describe("Google GenAI image description", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countTokens.mockResolvedValue(5);
    // recordLlmCall just runs the wrapped work and returns its result.
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) =>
      fn(),
    );
    mocks.createGoogleGenAI.mockReturnValue({
      models: { generateContent: mocks.generateContent },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the model's JSON title/description on success", async () => {
    mockMediaOk();
    mocks.generateContent.mockResolvedValue({
      text: JSON.stringify({
        title: "A cat",
        description: "A ginger cat on a sofa.",
      }),
    });

    const result = await handleImageDescription(
      createRuntime(),
      "https://example.com/cat.png",
    );

    expect(result).toEqual({
      title: "A cat",
      description: "A ginger cat on a sofa.",
    });
    expect(mocks.fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/cat.png",
        maxBytes: 20 * 1024 * 1024,
        timeoutMs: 15_000,
        maxRedirects: 5,
      }),
    );
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
  });

  it("parses a title/description out of prose when the model returns non-JSON", async () => {
    mockMediaOk();
    mocks.generateContent.mockResolvedValue({
      text: "Title: Sunset\nA warm orange sunset over the ocean.",
    });

    const result = await handleImageDescription(
      createRuntime(),
      "https://example.com/sunset.png",
    );

    expect(result.title).toBe("Sunset");
    expect(result.description).toContain("warm orange sunset");
  });

  it("throws when the client is not initialized instead of fabricating a result", async () => {
    mockMediaOk();
    mocks.createGoogleGenAI.mockReturnValue(null);

    await expect(
      handleImageDescription(createRuntime(), "https://example.com/x.png"),
    ).rejects.toThrow("Google Generative AI client not initialized");

    expect(mocks.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("throws when the image URL is empty instead of fetching", async () => {
    await expect(
      handleImageDescription(createRuntime(), { imageUrl: "" }),
    ).rejects.toThrow("IMAGE_DESCRIPTION requires a valid image URL");

    expect(mocks.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("throws when the guarded image fetch fails instead of fabricating a result", async () => {
    mocks.fetchRemoteMedia.mockRejectedValue(
      new Error(
        "Failed to fetch media from https://example.com/missing.png: HTTP 404 Not Found",
      ),
    );

    const result = handleImageDescription(
      createRuntime(),
      "https://example.com/missing.png",
    );

    await expect(result).rejects.toThrow(/Failed to fetch media/);
    // Must not swallow into a { title: "Failed to analyze image", ... } object.
    await expect(result).rejects.not.toHaveProperty("title");
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("fails closed on loopback and private image URLs without calling the model", async () => {
    const blocked = [
      "http://127.0.0.1/secret.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/internal.png",
      "http://10.0.0.5/intranet.png",
    ];

    for (const url of blocked) {
      mocks.fetchRemoteMedia.mockRejectedValueOnce(
        new Error(`Failed to fetch media from ${url}: blocked by SSRF policy`),
      );
      mocks.generateContent.mockClear();

      await expect(
        handleImageDescription(createRuntime(), url),
      ).rejects.toThrow(/Failed to fetch media|SSRF|blocked/i);
      expect(mocks.fetchRemoteMedia).toHaveBeenCalledWith(
        expect.objectContaining({ url }),
      );
      expect(mocks.generateContent).not.toHaveBeenCalled();
    }
  });

  it("propagates a provider rejection instead of fabricating a result", async () => {
    mockMediaOk();
    mocks.generateContent.mockRejectedValue(
      new Error("429 rate limit exceeded"),
    );

    const call = handleImageDescription(
      createRuntime(),
      "https://example.com/rate-limited.png",
    );

    await expect(call).rejects.toThrow("429 rate limit exceeded");
    // The rejection value is the real error, not a fabricated description object.
    await expect(call).rejects.toBeInstanceOf(Error);
    await expect(call).rejects.not.toHaveProperty("title");
  });

  it("throws on an empty model completion instead of returning an empty description", async () => {
    mockMediaOk();
    mocks.generateContent.mockResolvedValue({ text: "   " });

    await expect(
      handleImageDescription(createRuntime(), "https://example.com/blank.png"),
    ).rejects.toThrow("Google GenAI API returned an empty image description");
  });
});
