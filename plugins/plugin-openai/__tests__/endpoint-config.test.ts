/**
 * Verifies OpenAI-compatible inference and diagnostic endpoint resolution use
 * one policy for whitespace, process fallback, and Cerebras provider hints.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBaseURL, resolveOpenAIBaseURL } from "../index";

afterEach(() => vi.unstubAllEnvs());

describe("OpenAI-compatible endpoint config", () => {
  it("falls through whitespace runtime config and preserves Cerebras routing", () => {
    vi.stubEnv("OPENAI_BASE_URL", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("CEREBRAS_API_KEY", "csk-test");
    vi.stubEnv("CEREBRAS_BASE_URL", " https://process.cerebras.example/v1 ");
    vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
    const runtime = {
      getSetting: (key: string) =>
        key === "OPENAI_BASE_URL"
          ? " \t "
          : key === "ELIZA_MOCK_OPENAI_BASE"
            ? "https://config-mock.invalid/v1"
            : null,
    } as IAgentRuntime;

    const inferred = getBaseURL(runtime);
    const diagnosed = resolveOpenAIBaseURL((key) =>
      key === "ELIZA_PROVIDER" ? "cerebras" : process.env[key]
    );

    expect(inferred).toBe("https://process.cerebras.example/v1");
    expect(diagnosed).toBe(inferred);
  });
});

it.each(["", "  ", "unknown-backend"])("keeps credential fallback for selector %j", (selector) => {
  const settings: Record<string, string> = {
    ELIZA_PROVIDER: selector,
    CEREBRAS_API_KEY: "synthetic-cerebras",
  };
  expect(resolveOpenAIBaseURL((key) => settings[key])).toBe("https://api.cerebras.ai/v1");
});

it.each([
  [" openai ", "https://api.cerebras.ai/v1", "https://api.openai.com/v1"],
  ["cerebras", "https://api.openai.com/v1", "https://api.cerebras.ai/v1"],
  ["openai", "https://custom-gateway.example/v1", "https://custom-gateway.example/v1"],
  ["cerebras", "https://custom-gateway.example/v1", "https://custom-gateway.example/v1"],
])(
  "uses selector %s without leaking credentials to a stale first-party endpoint",
  (provider, base, expected) => {
    const settings: Record<string, string> = {
      ELIZA_PROVIDER: provider,
      OPENAI_BASE_URL: base,
      OPENAI_API_KEY: "synthetic-openai",
      CEREBRAS_API_KEY: "synthetic-cerebras",
    };
    expect(resolveOpenAIBaseURL((key) => settings[key])).toBe(expected);
  }
);
