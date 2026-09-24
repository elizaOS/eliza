/**
 * Verifies Anthropic inference and diagnostic endpoint resolution share the
 * same whitespace and process-environment fallback contract.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBaseURL, resolveAnthropicBaseURL } from "../index";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Anthropic endpoint config", () => {
  it("uses host endpoint policy even when the host exposes a document global", () => {
    vi.stubGlobal("document", {});
    vi.stubEnv("ELIZA_MOCK_ANTHROPIC_BASE", undefined);
    const runtime = {
      getSetting: (key: string) =>
        key === "ANTHROPIC_BASE_URL" ? "https://host.example/v1" : null,
    } as IAgentRuntime;
    expect(getBaseURL(runtime)).toBe("https://host.example/v1");
    expect(resolveAnthropicBaseURL(() => undefined)).toBe("https://api.anthropic.com/v1");
    expect(
      resolveAnthropicBaseURL(() => "https://host.example/v1", {
        mockBaseURL: " https://fixture.example/v1 ",
      })
    ).toBe("https://fixture.example/v1");
  });

  it("falls through a whitespace nested runtime setting to valid process env", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", " https://process.anthropic.example/v1 ");
    vi.stubEnv("ELIZA_MOCK_ANTHROPIC_BASE", undefined);
    const runtime = {
      getSetting: (key: string) =>
        key === "ANTHROPIC_BASE_URL"
          ? "   "
          : key === "ELIZA_MOCK_ANTHROPIC_BASE"
            ? "https://config-mock.invalid/v1"
            : null,
    } as IAgentRuntime;

    const inferred = getBaseURL(runtime);
    const diagnosed = resolveAnthropicBaseURL((key) =>
      key === "ANTHROPIC_BASE_URL" ? process.env.ANTHROPIC_BASE_URL : undefined
    );

    expect(inferred).toBe("https://process.anthropic.example/v1");
    expect(diagnosed).toBe(inferred);
  });
});
