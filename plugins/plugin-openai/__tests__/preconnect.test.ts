import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("warms the provider connection once per throttle window, not per message", async () => {
    const preconnect = vi.fn();
    (globalThis.fetch as unknown as { preconnect?: unknown }).preconnect = preconnect;
    await fireMessageReceived();
    await fireMessageReceived();
    expect(preconnect).toHaveBeenCalledTimes(1);
    expect(preconnect).toHaveBeenCalledWith("https://api.cerebras.ai/v1");
    vi.setSystemTime(1_000_000_000 + 20_000);
    await fireMessageReceived();
    expect(preconnect).toHaveBeenCalledTimes(2);
  });

  it("is a no-op where fetch.preconnect is absent", async () => {
    (globalThis.fetch as unknown as { preconnect?: unknown }).preconnect = undefined;
    await expect(fireMessageReceived()).resolves.not.toThrow();
  });
});
