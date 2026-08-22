/**
 * Unit tests for the settings-resolution helpers in `utils/config` — runtime vs
 * env precedence, blank trimming, model-alias fallback, and client creation.
 * `@google/genai` and the logger are mocked; no network.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT,
  DEFAULT_GOOGLE_EMBEDDING_MODEL,
  getApiKey,
  getEmbeddingInputTokenLimit,
  getEmbeddingModel,
  getGoogleGenAIBaseURL,
  getLargeModel,
  getResponseHandlerModel,
  getSmallModel,
} from "../utils/config";

const PLUGIN_ROOT = new URL("../", import.meta.url);
const REPOSITORY_ROOT = new URL("../../../", import.meta.url);

function readPluginJson(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, PLUGIN_ROOT)), "utf-8"),
  );
}

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
    expect(getLargeModel(runtime)).toBe("gemini-2.5-pro");
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

  it("wires a literal-loopback HTTP override into the production SDK", () => {
    const runtime = runtimeWith({
      GOOGLE_GENERATIVE_AI_API_KEY: "test-key",
      GOOGLE_GENERATIVE_AI_BASE_URL: " http://127.0.0.1:4567/google/ ",
    });

    expect(getGoogleGenAIBaseURL(runtime)).toBe("http://127.0.0.1:4567/google");
    createGoogleGenAI(runtime);
    expect(mocks.googleGenAI).toHaveBeenCalledWith({
      apiKey: "test-key",
      httpOptions: { baseUrl: "http://127.0.0.1:4567/google" },
    });
  });

  it("allows HTTPS and literal IPv4/IPv6 loopback while normalizing trailing path slashes", () => {
    expect(
      getGoogleGenAIBaseURL(
        runtimeWith({
          GOOGLE_GENERATIVE_AI_BASE_URL:
            "https://gateway.example.test/google///",
        }),
      ),
    ).toBe("https://gateway.example.test/google");
    expect(
      getGoogleGenAIBaseURL(
        runtimeWith({
          GOOGLE_GENERATIVE_AI_BASE_URL: "http://127.0.0.1:4567/google/",
        }),
      ),
    ).toBe("http://127.0.0.1:4567/google");
    expect(
      getGoogleGenAIBaseURL(
        runtimeWith({
          GOOGLE_GENERATIVE_AI_BASE_URL: "http://[::1]:4567/google/",
        }),
      ),
    ).toBe("http://[::1]:4567/google");
  });

  it.each([
    ["remote cleartext", "http://api.example.test/google", /must use HTTPS/],
    ["localhost DNS", "http://localhost:4567/google", /must use HTTPS/],
    [
      "embedded username",
      "https://user@gateway.example.test/google",
      /credentials/,
    ],
    [
      "embedded password",
      "https://user:pass@gateway.example.test/google",
      /credentials/,
    ],
    [
      "query",
      "https://gateway.example.test/google?key=value",
      /query or fragment/,
    ],
    [
      "fragment",
      "https://gateway.example.test/google#route",
      /query or fragment/,
    ],
    ["unsafe scheme", "file:///tmp/not-an-api", /HTTP or HTTPS/],
  ])(
    "rejects %s base URLs before creating a credentialed client",
    (_label, baseURL, pattern) => {
      expect(() =>
        getGoogleGenAIBaseURL(
          runtimeWith({ GOOGLE_GENERATIVE_AI_BASE_URL: baseURL }),
        ),
      ).toThrow(pattern);
    },
  );

  it("defaults the embedding model to a v1beta-valid id, not the 404-ing text-embedding-004", () => {
    // Regression: the historical default text-embedding-004 404s on the current
    // v1beta embedContent route. The default must be a currently-served id.
    expect(DEFAULT_GOOGLE_EMBEDDING_MODEL).toBe("gemini-embedding-001");
    expect(DEFAULT_GOOGLE_EMBEDDING_MODEL).not.toBe("text-embedding-004");
    expect(getEmbeddingModel(runtimeWith({}))).toBe("gemini-embedding-001");
  });

  it("honors an explicit GOOGLE_EMBEDDING_MODEL override over the default", () => {
    expect(
      getEmbeddingModel(
        runtimeWith({ GOOGLE_EMBEDDING_MODEL: " text-embedding-004 " }),
      ),
    ).toBe("text-embedding-004");
  });

  it("resolves model-aware embedding input token limits with a safe default", () => {
    // gemini-embedding-001 documents a 2,048-token input limit; the larger
    // gemini-embedding-2 window accepts 8,192. Unmapped overrides must fall back
    // to the safe default (2,048), never the larger window.
    expect(getEmbeddingInputTokenLimit("gemini-embedding-001")).toBe(2_048);
    expect(getEmbeddingInputTokenLimit("models/gemini-embedding-001")).toBe(
      2_048,
    );
    expect(getEmbeddingInputTokenLimit("gemini-embedding-2")).toBe(8_192);
    expect(getEmbeddingInputTokenLimit("models/gemini-embedding-2")).toBe(
      8_192,
    );
    expect(getEmbeddingInputTokenLimit("some-unknown-model")).toBe(
      DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT,
    );
    expect(getEmbeddingInputTokenLimit("models/some-unknown-model")).toBe(
      DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT,
    );
    expect(
      getEmbeddingInputTokenLimit(
        "publishers/google/models/gemini-embedding-2",
      ),
    ).toBe(DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT);
    expect(DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT).toBe(2_048);
    // The default model's limit must equal the safe fallback so an unknown id is
    // never truncated to a window wider than the shipped default supports.
    expect(getEmbeddingInputTokenLimit(DEFAULT_GOOGLE_EMBEDDING_MODEL)).toBe(
      DEFAULT_EMBEDDING_INPUT_TOKEN_LIMIT,
    );
  });

  it("keeps package.json and registry-entry.json embedding defaults in sync with DEFAULT_GOOGLE_EMBEDDING_MODEL", () => {
    // Drift guard: both public config sources previously advertised the retired
    // text-embedding-004 while the runtime default moved to gemini-embedding-001.
    // Assert they derive from the same source of truth so they cannot drift again.
    const pkg = readPluginJson("package.json") as {
      agentConfig: {
        pluginParameters: { GOOGLE_EMBEDDING_MODEL: { default: string } };
      };
    };
    const registry = readPluginJson("registry-entry.json") as {
      config: {
        GOOGLE_EMBEDDING_MODEL: { default: string; placeholder: string };
      };
    };
    const generated = readPluginJsonFromRepository(
      "packages/registry/src/first-party/generated.json",
    ) as {
      entries: Array<{
        id: string;
        config: {
          GOOGLE_EMBEDDING_MODEL?: { default?: string; placeholder?: string };
        };
      }>;
    };

    expect(
      pkg.agentConfig.pluginParameters.GOOGLE_EMBEDDING_MODEL.default,
    ).toBe(DEFAULT_GOOGLE_EMBEDDING_MODEL);
    expect(registry.config.GOOGLE_EMBEDDING_MODEL.default).toBe(
      DEFAULT_GOOGLE_EMBEDDING_MODEL,
    );
    const generatedGoogle = generated.entries.find(
      (entry) => entry.id === "google-genai",
    );
    expect(generatedGoogle?.config.GOOGLE_EMBEDDING_MODEL).toEqual(
      registry.config.GOOGLE_EMBEDDING_MODEL,
    );
    // The placeholder must name valid Google embedding ids, not an OpenAI model.
    const placeholder = registry.config.GOOGLE_EMBEDDING_MODEL.placeholder;
    expect(placeholder).toContain("gemini-embedding");
    expect(placeholder).not.toMatch(/text-embedding-3|gpt-|openai/i);
  });
});

function readPluginJsonFromRepository(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(relativePath, REPOSITORY_ROOT)),
      "utf-8",
    ),
  );
}
