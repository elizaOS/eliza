/** Proves Telegram typing remains visible for the whole in-flight agent turn. */
import { describe, expect, mock, test } from "bun:test";
import type {
  ChatEvent,
  PlatformAdapter,
  WebhookConfig,
} from "../src/adapters/types";
import { startTypingRefreshLoop } from "../src/webhook-handler";

describe("Telegram typing refresh", () => {
  test("refreshes until stopped and never overlaps a slow send", async () => {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter = {
      platform: "telegram",
      sendTypingIndicator: mock(async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 12));
        inFlight -= 1;
      }),
    } as unknown as PlatformAdapter;
    const event = { platform: "telegram" } as ChatEvent;

    const stop = startTypingRefreshLoop(adapter, {} as WebhookConfig, event, 5);
    await new Promise((resolve) => setTimeout(resolve, 34));
    stop();
    const callsWhenStopped = calls;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(callsWhenStopped).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(callsWhenStopped);
    expect(maxInFlight).toBe(1);
  });
});
