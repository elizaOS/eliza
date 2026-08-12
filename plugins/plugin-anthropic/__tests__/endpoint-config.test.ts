/**
 * Verifies Anthropic inference and diagnostic endpoint resolution share the
 * same whitespace and process-environment fallback contract.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBaseURL, resolveAnthropicBaseURL } from "../utils/config";

afterEach(() => vi.unstubAllEnvs());

describe("Anthropic endpoint config", () => {
  it("falls through a whitespace nested runtime setting to valid process env", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", " https://process.anthropic.example/v1 ");
    vi.stubEnv("ELIZA_MOCK_ANTHROPIC_BASE", undefined);
    const runtime = {
      getSetting: (key: string) => (key === "ANTHROPIC_BASE_URL" ? "   " : null),
    } as IAgentRuntime;

    const inferred = getBaseURL(runtime);
    const diagnosed = resolveAnthropicBaseURL((key) =>
      key === "ANTHROPIC_BASE_URL" ? process.env.ANTHROPIC_BASE_URL : undefined
    );

    expect(inferred).toBe("https://process.anthropic.example/v1");
    expect(diagnosed).toBe(inferred);
  });
});
