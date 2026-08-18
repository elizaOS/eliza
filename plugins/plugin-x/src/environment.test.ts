/**
 * Regression coverage for the negative-interval gap: `safeParseInt` only
 * rejected `NaN`, so an operator-set negative TWITTER_POST_INTERVAL_MIN
 * passed getRandomInterval's `minInterval < maxInterval` guard and produced a
 * mostly-negative "interval" in minutes. post.ts feeds that value straight
 * into `setTimeout(resolve, postIntervalMinutes * 60 * 1000)`; a negative
 * delay collapses to (near) 0, defeating the posting-rate limiter and
 * risking spam/ban on the connected account.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRandomInterval } from "./environment";

function makeRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

describe("getRandomInterval", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clamps a negative min interval instead of returning a negative delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const runtime = makeRuntime({
      TWITTER_POST_INTERVAL_MIN: "-9999999",
      TWITTER_POST_INTERVAL_MAX: "180",
    });

    const interval = getRandomInterval(runtime, "post");

    // Negative min is clamped to 0 by safeParseInt, so the random draw lands
    // in [0, 180] instead of [-9999999, 180]. Math.random() is mocked to
    // 0.5, so the midpoint of the clamped range is exact.
    expect(interval).toBe(90);
    expect(interval).toBeGreaterThanOrEqual(0);
  });

  it("falls back to the fixed interval when min and max are both negative", () => {
    const runtime = makeRuntime({
      TWITTER_POST_INTERVAL_MIN: "-100",
      TWITTER_POST_INTERVAL_MAX: "-50",
      TWITTER_POST_INTERVAL: "120",
    });

    const interval = getRandomInterval(runtime, "post");

    // Both bounds clamp to the 0 default, so minInterval < maxInterval is
    // false (0 < 0) and the function falls through to the fixed interval
    // instead of returning a negative or nonsensical value.
    expect(interval).toBe(120);
  });

  it("still returns a normal random interval when min/max are valid", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const runtime = makeRuntime({
      TWITTER_POST_INTERVAL_MIN: "90",
      TWITTER_POST_INTERVAL_MAX: "180",
    });

    const interval = getRandomInterval(runtime, "post");

    expect(interval).toBe(135);
  });
});
