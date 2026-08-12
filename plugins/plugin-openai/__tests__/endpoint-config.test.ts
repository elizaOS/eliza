/**
 * Verifies OpenAI-compatible inference and diagnostic endpoint resolution use
 * one policy for whitespace, process fallback, and Cerebras provider hints.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBaseURL, resolveOpenAIBaseURL } from "../utils/config";

afterEach(() => vi.unstubAllEnvs());

describe("OpenAI-compatible endpoint config", () => {
  it("falls through whitespace runtime config and preserves Cerebras routing", () => {
    vi.stubEnv("OPENAI_BASE_URL", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("CEREBRAS_API_KEY", "csk-test");
    vi.stubEnv("CEREBRAS_BASE_URL", " https://process.cerebras.example/v1 ");
    vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
    const runtime = {
      getSetting: (key: string) => (key === "OPENAI_BASE_URL" ? " \t " : null),
    } as IAgentRuntime;

    const inferred = getBaseURL(runtime);
    const diagnosed = resolveOpenAIBaseURL((key) =>
      key === "ELIZA_PROVIDER" ? "cerebras" : process.env[key]
    );

    expect(inferred).toBe("https://process.cerebras.example/v1");
    expect(diagnosed).toBe(inferred);
  });
});
