/**
 * Deterministic production-boundary coverage for plugin-x interval parsing.
 * A fake runtime supplies settings while the real configuration validator and
 * scheduler helper reject partial or zero interval magnitudes.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getRandomInterval, validateTwitterConfig } from "./environment";

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

describe("validateTwitterConfig interval settings", () => {
  const intervalDefaults = {
    TWITTER_DM_POLL_INTERVAL_SECONDS: "60",
    TWITTER_POST_INTERVAL: "120",
    TWITTER_POST_INTERVAL_MIN: "90",
    TWITTER_POST_INTERVAL_MAX: "180",
    TWITTER_ENGAGEMENT_INTERVAL: "30",
    TWITTER_ENGAGEMENT_INTERVAL_MIN: "20",
    TWITTER_ENGAGEMENT_INTERVAL_MAX: "40",
    TWITTER_DISCOVERY_INTERVAL_MIN: "15",
    TWITTER_DISCOVERY_INTERVAL_MAX: "30",
  } as const;

  it.each(Object.entries(intervalDefaults))(
    "rejects a partial %s value at the public configuration boundary",
    async (key, defaultValue) => {
      const config = await validateTwitterConfig(
        makeRuntime({
          TWITTER_AUTH_MODE: "broker",
          TWITTER_BROKER_TOKEN: "test-token",
          [key]: "1h",
        }),
      );
      expect(config[key as keyof typeof intervalDefaults]).toBe(defaultValue);
    },
  );

  it("accepts whitespace-padded whole interval values", async () => {
    const config = await validateTwitterConfig(
      makeRuntime({
        TWITTER_AUTH_MODE: "broker",
        TWITTER_BROKER_TOKEN: "test-token",
        TWITTER_DM_POLL_INTERVAL_SECONDS: "  15  ",
        TWITTER_POST_INTERVAL: "  90  ",
      }),
    );
    expect(config.TWITTER_DM_POLL_INTERVAL_SECONDS).toBe("15");
    expect(config.TWITTER_POST_INTERVAL).toBe("90");
  });

  it("does not widen the interval fix to zero-valued non-interval settings", async () => {
    const config = await validateTwitterConfig(
      makeRuntime({
        TWITTER_AUTH_MODE: "broker",
        TWITTER_BROKER_TOKEN: "test-token",
        TWITTER_MAX_ENGAGEMENTS_PER_RUN: "0",
        TWITTER_RETRY_LIMIT: "0",
      }),
    );
    expect(config.TWITTER_MAX_ENGAGEMENTS_PER_RUN).toBe("0");
    expect(config.TWITTER_RETRY_LIMIT).toBe("0");
  });
});
