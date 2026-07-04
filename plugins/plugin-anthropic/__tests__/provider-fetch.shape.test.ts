/**
 * Shape tests for the custom fetch wrapper in the client factory: verifies it
 * survives malformed JSON request bodies and strips `temperature` only when a
 * JSON body carries both `top_p` and a zero temperature. `@ai-sdk/anthropic` is
 * mocked to capture the wrapped fetch; no live API.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAnthropic: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mocks.createAnthropic,
}));

function createRuntime(settings: Record<string, string | undefined> = {}) {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  mocks.createAnthropic.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("Anthropic provider fetch plumbing", () => {
  it("does not throw before fetch when the request body is malformed JSON", async () => {
    const upstreamFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", upstreamFetch);
    mocks.createAnthropic.mockReturnValue(() => ({ modelId: "claude-test" }));

    const { createAnthropicClientWithTopPSupport } = await import("../providers/anthropic");
    createAnthropicClientWithTopPSupport(
      createRuntime({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_AUTH_MODE: "apikey" })
    );

    const options = mocks.createAnthropic.mock.calls[0][0] as { fetch: typeof fetch };
    await expect(
      options.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: "{not-json",
      })
    ).resolves.toBeInstanceOf(Response);

    expect(upstreamFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ body: "{not-json" })
    );
  }, 60_000);

  it("removes temperature only for object bodies with top_p and zero temperature", async () => {
    const upstreamFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", upstreamFetch);
    mocks.createAnthropic.mockReturnValue(() => ({ modelId: "claude-test" }));

    const { createAnthropicClientWithTopPSupport } = await import("../providers/anthropic");
    createAnthropicClientWithTopPSupport(
      createRuntime({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_AUTH_MODE: "apikey" })
    );

    const options = mocks.createAnthropic.mock.calls[0][0] as { fetch: typeof fetch };
    await options.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ top_p: 0.8, temperature: 0, messages: [] }),
    });

    const init = upstreamFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ top_p: 0.8, messages: [] });
  }, 60_000);
});
