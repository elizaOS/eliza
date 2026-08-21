/**
 * Deterministic unit coverage for getRandomInterval's env parsing: negative,
 * zero, partial (`1h`, `90s`), and non-numeric TWITTER_*_INTERVAL values must
 * fall back instead of surviving parseInt's prefix match and collapsing the
 * scheduler's setTimeout delay to ~0. Fake runtime whose getSetting reads a
 * map; Math.random is stubbed.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getRandomInterval } from "./environment";

function makeRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? null,
  } as unknown as IAgentRuntime;
}

describe("getRandomInterval", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws between configured min and max", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const interval = getRandomInterval(
      makeRuntime({
        TWITTER_POST_INTERVAL_MIN: "90",
        TWITTER_POST_INTERVAL_MAX: "180",
      }),
      "post",
    );
    expect(interval).toBe(135);
  });

  it("ignores a negative min instead of treating it as 0 and drawing in [0, max]", () => {
    const interval = getRandomInterval(
      makeRuntime({
        TWITTER_POST_INTERVAL_MIN: "-9999999",
        TWITTER_POST_INTERVAL_MAX: "180",
      }),
      "post",
    );
    expect(interval).toBe(120);
  });

  it("falls back to the fixed interval when both bounds are negative", () => {
    const interval = getRandomInterval(
      makeRuntime({
        TWITTER_ENGAGEMENT_INTERVAL_MIN: "-20",
        TWITTER_ENGAGEMENT_INTERVAL_MAX: "-5",
        TWITTER_ENGAGEMENT_INTERVAL: "30",
      }),
      "engagement",
    );
    expect(interval).toBe(30);
  });

  it("rejects a negative fixed interval and uses the documented default", () => {
    const interval = getRandomInterval(
      makeRuntime({ TWITTER_POST_INTERVAL: "-120" }),
      "post",
    );
    expect(interval).toBe(120);
  });

  it("keeps non-numeric input falling back unchanged", () => {
    const interval = getRandomInterval(
      makeRuntime({ TWITTER_POST_INTERVAL: "abc" }),
      "post",
    );
    expect(interval).toBe(120);
  });

  it.each(["1h", "90s", "120min", "12.5", "1e3", "0", "+120", " 120 min"])(
    "rejects partial or zero interval %p and uses the documented default",
    (value) => {
      const interval = getRandomInterval(
        makeRuntime({ TWITTER_POST_INTERVAL: value }),
        "post",
      );
      expect(interval).toBe(120);
    },
  );

  it("still accepts a whitespace-padded whole minute count", () => {
    const interval = getRandomInterval(
      makeRuntime({ TWITTER_POST_INTERVAL: "  90  " }),
      "post",
    );
    expect(interval).toBe(90);
  });
});
