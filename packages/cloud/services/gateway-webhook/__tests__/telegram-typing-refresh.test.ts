/** Exercises real typing refresh timers with controlled in-flight transport completion. */
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
    const firstSend = Promise.withResolvers<void>();
    const secondSend = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const adapter = {
      platform: "telegram",
      sendTypingIndicator: mock(async () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (calls === 1) {
          await firstSend.promise;
        } else if (calls === 2) {
          secondStarted.resolve();
          await secondSend.promise;
        }
        inFlight -= 1;
      }),
    } as unknown as PlatformAdapter;
    const event = { platform: "telegram" } as ChatEvent;

    const stop = startTypingRefreshLoop(adapter, {} as WebhookConfig, event, 5);
    let nextRefreshDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Several refresh deadlines pass while the first transport remains blocked.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(1);
      expect(inFlight).toBe(1);

      firstSend.resolve();
      // Observe the actual next refresh, rather than assuming it started before
      // a wall-clock deadline on a loaded worker.
      await Promise.race([
        secondStarted.promise,
        new Promise<never>((_resolve, reject) => {
          nextRefreshDeadline = setTimeout(
            () =>
              reject(
                new Error(
                  "Typing refresh did not resume after the first send completed",
                ),
              ),
            3000,
          );
        }),
      ]);
      clearTimeout(nextRefreshDeadline);
      expect(calls).toBe(2);
      expect(maxInFlight).toBe(1);

      stop();
      secondSend.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(inFlight).toBe(0);
      expect(calls).toBe(2);
      expect(maxInFlight).toBe(1);
    } finally {
      clearTimeout(nextRefreshDeadline);
      stop();
      firstSend.resolve();
      secondSend.resolve();
    }
  });
});
