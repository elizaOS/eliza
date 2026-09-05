import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiPlugin } from "../index";

const runtime = {
  getSetting: (key: string) =>
    key === "OPENAI_BASE_URL" ? "https://api.cerebras.ai/v1" : undefined,
} as unknown as IAgentRuntime;

async function fireMessageReceived() {
  const handlers = openaiPlugin.events?.MESSAGE_RECEIVED ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (const handler of handlers) {
    await handler({ runtime } as never);
  }
}

describe("provider preconnect on message ingress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("warms the provider connection once per throttle window, not per message", async () => {
    const preconnect = vi.fn();
    const fetch = vi.fn();
    // Bun's native fetch.preconnect is readonly; replace the fetch binding instead.
    vi.stubGlobal("fetch", Object.assign(fetch, { preconnect }));
    await fireMessageReceived();
    await fireMessageReceived();
    expect(preconnect).toHaveBeenCalledTimes(1);
    expect(preconnect).toHaveBeenCalledWith("https://api.cerebras.ai/v1");
    vi.setSystemTime(1_000_000_000 + 20_000);
    await fireMessageReceived();
    expect(preconnect).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is a no-op where fetch.preconnect is absent", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fireMessageReceived()).resolves.not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
