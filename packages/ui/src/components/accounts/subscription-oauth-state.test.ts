import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSubscriptionOAuth,
  readSubscriptionOAuth,
  writeSubscriptionOAuth,
} from "./subscription-oauth-state";

describe("subscription OAuth persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("restores a device flow and its one-time code after a remount", () => {
    writeSubscriptionOAuth({
      providerId: "openai-codex",
      sessionId: "session-1",
      mode: "device",
      phase: "waiting",
      deviceCode: "ABCD-EFGHI",
      startedAt: Date.now(),
    });

    expect(readSubscriptionOAuth("openai-codex")).toMatchObject({
      sessionId: "session-1",
      mode: "device",
      phase: "waiting",
      deviceCode: "ABCD-EFGHI",
    });
  });

  it("keeps provider flows isolated and clears only explicit cancellation", () => {
    writeSubscriptionOAuth({
      providerId: "anthropic-subscription",
      sessionId: "claude-session",
      mode: "device",
      phase: "need-code",
      startedAt: Date.now(),
    });
    expect(readSubscriptionOAuth("openai-codex")).toBeNull();
    expect(readSubscriptionOAuth("anthropic-subscription")?.sessionId).toBe(
      "claude-session",
    );

    clearSubscriptionOAuth("anthropic-subscription");
    expect(readSubscriptionOAuth("anthropic-subscription")).toBeNull();
  });

  it("retires stale flow records instead of reopening dead sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00Z"));
    writeSubscriptionOAuth({
      providerId: "openai-codex",
      sessionId: "expired",
      mode: "localhost",
      phase: "need-code",
      startedAt: Date.now(),
    });
    vi.advanceTimersByTime(21 * 60 * 1000);
    expect(readSubscriptionOAuth("openai-codex")).toBeNull();
  });
});
