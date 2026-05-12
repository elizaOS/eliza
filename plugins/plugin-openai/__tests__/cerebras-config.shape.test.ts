import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleTextEmbedding } from "../models/embedding";
import { getApiKey, getBaseURL } from "../utils/config";

function buildRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => (key in settings ? (settings[key] ?? null) : null)),
  } as IAgentRuntime;
}

const ENV_KEYS = [
  "ELIZA_PROVIDER",
  "OPENAI_BASE_URL",
  "CEREBRAS_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_URL",
  "OPENAI_EMBEDDING_DIMENSIONS",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
  vi.restoreAllMocks();
});

describe("plugin-openai Cerebras config (pure)", () => {
  it("resolves Cerebras base URL and key when OPENAI_BASE_URL points at cerebras.ai", () => {
    const runtime = buildRuntime({
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      CEREBRAS_API_KEY: "csk-cerebras-fake",
      OPENAI_API_KEY: undefined,
    });
    expect(getBaseURL(runtime)).toBe("https://api.cerebras.ai/v1");
    expect(getApiKey(runtime)).toBe("csk-cerebras-fake");
  });

  it("prefers CEREBRAS_API_KEY over OPENAI_API_KEY in Cerebras mode", () => {
    const runtime = buildRuntime({
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      CEREBRAS_API_KEY: "csk-cerebras-fake",
      OPENAI_API_KEY: "sk-openai-fake",
    });
    expect(getApiKey(runtime)).toBe("csk-cerebras-fake");
  });

  it("falls back to OPENAI_API_KEY when CEREBRAS_API_KEY is unset, even in Cerebras mode", () => {
    const runtime = buildRuntime({
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      CEREBRAS_API_KEY: undefined,
      OPENAI_API_KEY: "sk-openai-fake",
    });
    expect(getApiKey(runtime)).toBe("sk-openai-fake");
  });

  it("does not consume CEREBRAS_API_KEY when no Cerebras hint is present", () => {
    const runtime = buildRuntime({
      OPENAI_BASE_URL: undefined,
      CEREBRAS_API_KEY: "csk-cerebras-fake",
      OPENAI_API_KEY: "sk-openai-fake",
    });
    expect(getBaseURL(runtime)).toBe("https://api.openai.com/v1");
    expect(getApiKey(runtime)).toBe("sk-openai-fake");
  });

  it("treats ELIZA_PROVIDER=cerebras as a Cerebras hint independent of base URL", () => {
    const runtime = buildRuntime({
      ELIZA_PROVIDER: "cerebras",
      OPENAI_BASE_URL: undefined,
      CEREBRAS_API_KEY: "csk-cerebras-fake",
      OPENAI_API_KEY: "sk-openai-fake",
    });
    expect(getApiKey(runtime)).toBe("csk-cerebras-fake");
  });

  it("respects an explicit OPENAI_BASE_URL for OpenAI-compatible non-Cerebras endpoints", () => {
    const runtime = buildRuntime({
      OPENAI_BASE_URL: "https://api.openrouter.ai/api/v1",
      CEREBRAS_API_KEY: "csk-cerebras-fake",
      OPENAI_API_KEY: "sk-openrouter-fake",
    });
    expect(getBaseURL(runtime)).toBe("https://api.openrouter.ai/api/v1");
    expect(getApiKey(runtime)).toBe("sk-openrouter-fake");
  });

  it("uses a deterministic local embedding fallback in Cerebras mode without an embedding endpoint", async () => {
    const runtime = buildRuntime({
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      CEREBRAS_API_KEY: "csk-cerebras-fake",
      OPENAI_EMBEDDING_DIMENSIONS: "1536",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("remote embeddings should not be called"));

    const first = await handleTextEmbedding(runtime, { text: "remember the launch code" });
    const second = await handleTextEmbedding(runtime, { text: "remember the launch code" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(first).toHaveLength(1536);
    expect(first).toEqual(second);
    expect(first.some((value) => value !== 0)).toBe(true);
  });
});
