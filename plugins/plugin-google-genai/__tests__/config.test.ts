import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  googleGenAI: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  logger: {
    error: mocks.loggerError,
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: mocks.googleGenAI,
  HarmBlockThreshold: {
    BLOCK_MEDIUM_AND_ABOVE: "BLOCK_MEDIUM_AND_ABOVE",
  },
  HarmCategory: {
    HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
    HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  },
}));

import {
  createGoogleGenAI,
  getApiKey,
  getLargeModel,
  getResponseHandlerModel,
  getSmallModel,
} from "../utils/config";

type Settings = Record<string, string | null | undefined>;

const originalEnv = { ...process.env };

function runtimeWith(settings: Settings): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as IAgentRuntime;
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

describe("Google GenAI config", () => {
  it("prefers non-empty runtime settings and falls back to environment values", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = " env-key ";
    process.env.SMALL_MODEL = " env-small ";

    expect(
      getApiKey(
        runtimeWith({
          GOOGLE_GENERATIVE_AI_API_KEY: " runtime-key ",
        }),
      ),
    ).toBe("runtime-key");
    expect(
      getApiKey(
        runtimeWith({
          GOOGLE_GENERATIVE_AI_API_KEY: "",
        }),
      ),
    ).toBe("env-key");
    expect(
      getSmallModel(
        runtimeWith({
          GOOGLE_SMALL_MODEL: null,
        }),
      ),
    ).toBe("env-small");
  });

  it("falls through model aliases before using package defaults", () => {
    const runtime = runtimeWith({
      GOOGLE_RESPONSE_HANDLER_MODEL: "",
      GOOGLE_SHOULD_RESPOND_MODEL: " google-response ",
      GOOGLE_LARGE_MODEL: null,
      LARGE_MODEL: undefined,
    });

    expect(getResponseHandlerModel(runtime)).toBe("google-response");
    expect(getLargeModel(runtime)).toBe("gemini-2.5-pro-preview-03-25");
  });

  it("does not create a Google client for blank API keys", () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "   ";

    expect(createGoogleGenAI(runtimeWith({}))).toBeNull();
    expect(mocks.googleGenAI).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Google Generative AI API Key is missing",
    );
  });

  it("creates a Google client with the trimmed API key", () => {
    createGoogleGenAI(
      runtimeWith({
        GOOGLE_GENERATIVE_AI_API_KEY: " test-key ",
      }),
    );

    expect(mocks.googleGenAI).toHaveBeenCalledWith({ apiKey: "test-key" });
  });
});
