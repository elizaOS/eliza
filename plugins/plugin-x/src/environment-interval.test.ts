/**
 * `getRandomInterval` must honor a pinned cadence: when MIN equals MAX the
 * operator asked for one exact interval, not a range. The random branch used
 * to require MIN < MAX, so MIN == MAX silently fell back to the fixed
 * interval (for example 60/60 returned 120 for posts).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRandomInterval } from "./environment";

const INTERVAL_KEYS = [
  "TWITTER_POST_INTERVAL",
  "TWITTER_POST_INTERVAL_MIN",
  "TWITTER_POST_INTERVAL_MAX",
  "TWITTER_ENGAGEMENT_INTERVAL",
  "TWITTER_ENGAGEMENT_INTERVAL_MIN",
  "TWITTER_ENGAGEMENT_INTERVAL_MAX",
  "TWITTER_DISCOVERY_INTERVAL_MIN",
  "TWITTER_DISCOVERY_INTERVAL_MAX",
];

function runtimeWith(settings: Record<string, string>) {
  const runtime = {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };
  return runtime as unknown as IAgentRuntime;
}

beforeEach(() => {
  for (const key of INTERVAL_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of INTERVAL_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

describe("getRandomInterval with MIN equal to MAX", () => {
  it("returns the pinned post interval instead of the fixed default", () => {
    const runtime = runtimeWith({
      TWITTER_POST_INTERVAL_MIN: "60",
      TWITTER_POST_INTERVAL_MAX: "60",
    });
    expect(getRandomInterval(runtime, "post")).toBe(60);
  });

  it("returns the pinned engagement interval instead of the fixed default", () => {
    const runtime = runtimeWith({
      TWITTER_ENGAGEMENT_INTERVAL_MIN: "45",
      TWITTER_ENGAGEMENT_INTERVAL_MAX: "45",
    });
    expect(getRandomInterval(runtime, "engagement")).toBe(45);
  });

  it("returns the pinned discovery interval instead of the fixed default", () => {
    const runtime = runtimeWith({
      TWITTER_DISCOVERY_INTERVAL_MIN: "25",
      TWITTER_DISCOVERY_INTERVAL_MAX: "25",
    });
    expect(getRandomInterval(runtime, "discovery")).toBe(25);
  });

  it("still draws inside a real MIN/MAX range", () => {
    const runtime = runtimeWith({
      TWITTER_POST_INTERVAL_MIN: "60",
      TWITTER_POST_INTERVAL_MAX: "120",
    });
    const value = getRandomInterval(runtime, "post");
    expect(value).toBeGreaterThanOrEqual(60);
    expect(value).toBeLessThanOrEqual(120);
  });

  it("still falls back to the fixed interval when MIN is above MAX", () => {
    const runtime = runtimeWith({
      TWITTER_POST_INTERVAL_MIN: "120",
      TWITTER_POST_INTERVAL_MAX: "60",
      TWITTER_POST_INTERVAL: "90",
    });
    expect(getRandomInterval(runtime, "post")).toBe(90);
  });
});
