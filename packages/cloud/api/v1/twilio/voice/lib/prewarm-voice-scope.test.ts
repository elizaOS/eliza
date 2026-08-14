/** Proves inbound Twilio prewarm starts immediately and stays non-fatal. */

import { describe, expect, mock, test } from "bun:test";
import { scheduleTwilioVoiceScopePrewarm } from "./prewarm-voice-scope";

const claims = {
  agentId: "agent-voice",
  conversationId: "conversation-voice",
  organizationId: "org-voice",
  userId: "user-voice",
};

describe("Twilio voice scope prewarm", () => {
  test("registers and runs hydration without blocking the caller", async () => {
    const waits: Promise<unknown>[] = [];
    let releaseHydration: (() => void) | undefined;
    const hydrateScope = mock(
      () =>
        new Promise<void>((resolve) => {
          releaseHydration = resolve;
        }),
    );

    const prewarm = scheduleTwilioVoiceScopePrewarm({
      claims,
      env: {} as never,
      executionCtx: { waitUntil: (promise) => waits.push(promise) },
      hydrateScope,
    });

    await Promise.resolve();
    expect(hydrateScope).toHaveBeenCalledWith({}, claims);
    expect(waits).toEqual([prewarm]);
    releaseHydration?.();
    await prewarm;
  });

  test("contains hydration failure for the media session fallback", async () => {
    const waits: Promise<unknown>[] = [];
    const prewarm = scheduleTwilioVoiceScopePrewarm({
      claims,
      env: {} as never,
      executionCtx: { waitUntil: (promise) => waits.push(promise) },
      hydrateScope: async () => {
        throw new Error("database unavailable");
      },
    });

    await expect(prewarm).resolves.toBeUndefined();
    await expect(waits[0]).resolves.toBeUndefined();
  });
});
