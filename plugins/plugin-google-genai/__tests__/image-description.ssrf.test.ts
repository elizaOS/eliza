/**
 * Integration-backed unit tests for IMAGE_DESCRIPTION SSRF fail-closed: real
 * `@elizaos/core` `fetchRemoteMedia` policy against literal private/loopback
 * hosts, with only the Gemini client and LLM call layers mocked. Proves the
 * handler never reaches the model for blocked image URLs.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGoogleGenAI: vi.fn(),
  generateContent: vi.fn(),
  countTokens: vi.fn(),
  recordLlmCall: vi.fn(),
}));

vi.mock("@elizaos/core", async (importActual) => {
  const actual = await importActual<typeof import("@elizaos/core")>();
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

describe("Google GenAI image description SSRF policy (real fetchRemoteMedia)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countTokens.mockResolvedValue(5);
    mocks.recordLlmCall.mockImplementation(async (_runtime, _details, fn) =>
      fn(),
    );
    mocks.createGoogleGenAI.mockReturnValue({
      models: { generateContent: mocks.generateContent },
    });
    mocks.generateContent.mockResolvedValue({
      text: JSON.stringify({ title: "x", description: "y" }),
    });
  });

  it.each([
    "http://127.0.0.1/secret.png",
    "http://[::1]/secret.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/internal.png",
    "http://10.0.0.5/intranet.png",
    "http://192.168.1.1/router.png",
  ])(
    "fails closed for blocked image URL %s without calling the model",
    async (url) => {
      await expect(
        handleImageDescription(createRuntime(), url),
      ).rejects.toThrow(
        /Failed to fetch media|not allowed|blocked|private|loopback|link-local|Invalid URL|SSRF/i,
      );
      expect(mocks.generateContent).not.toHaveBeenCalled();
      expect(mocks.recordLlmCall).not.toHaveBeenCalled();
    },
  );
});
