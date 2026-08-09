/** Verifies the messaging→cloud onboarding continuation hand-through. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingOnboardingSession,
  completePendingOnboardingContinuation,
  type OnboardingContinuationTransport,
  peekPendingOnboardingSession,
  previewPendingOnboardingContinuation,
  sanitizeOnboardingSessionToken,
  storePendingOnboardingSession,
} from "./onboarding-continuation";

// Obviously-fake, low-entropy stand-in for the opaque continuation UUID
// (a realistic random UUID here trips the gitleaks generic-api-key rule).
const TOKEN = "aaaaaaaa-test-test-test-tokentoken01";

afterEach(() => {
  clearPendingOnboardingSession();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("sanitizeOnboardingSessionToken", () => {
  it("accepts the opaque continuation shape", () => {
    expect(sanitizeOnboardingSessionToken(TOKEN)).toBe(TOKEN);
    expect(sanitizeOnboardingSessionToken(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  it("rejects platform-scoped ids — only a trusted gateway may present those", () => {
    expect(
      sanitizeOnboardingSessionToken("platform:discord:999900000000000099"),
    ).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(sanitizeOnboardingSessionToken(null)).toBeNull();
    expect(sanitizeOnboardingSessionToken("")).toBeNull();
    expect(sanitizeOnboardingSessionToken("short")).toBeNull();
    expect(sanitizeOnboardingSessionToken("a".repeat(200))).toBeNull();
    expect(sanitizeOnboardingSessionToken("bad token with spaces")).toBeNull();
    expect(
      sanitizeOnboardingSessionToken("<script>alert(1)</script>"),
    ).toBeNull();
  });
});

describe("pending-token persistence", () => {
  it("survives a login round trip (store → peek)", () => {
    storePendingOnboardingSession(TOKEN);
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
    // Peek does NOT consume — a failed redemption must be retryable.
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
  });

  it("never stores an invalid token", () => {
    storePendingOnboardingSession("platform:discord:123456789012");
    expect(peekPendingOnboardingSession()).toBeNull();
  });

  it("expires the stored token", () => {
    vi.useFakeTimers();
    storePendingOnboardingSession(TOKEN);
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    expect(peekPendingOnboardingSession()).toBeNull();
  });

  it("clears from every storage", () => {
    storePendingOnboardingSession(TOKEN);
    clearPendingOnboardingSession();
    expect(peekPendingOnboardingSession()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });
});

describe("previewPendingOnboardingContinuation", () => {
  it("loads the trusted Discord identity without redeeming it", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        platform: "discord",
        platformUserId: "1234567890",
        platformDisplayName: "attested-user",
      },
    });
    const preview = await previewPendingOnboardingContinuation(TOKEN, {
      get,
      post: vi.fn(),
    });
    expect(get).toHaveBeenCalledWith(
      `/api/eliza-app/onboarding/chat?sessionId=${encodeURIComponent(TOKEN)}`,
    );
    expect(preview.platformDisplayName).toBe("attested-user");
  });
});

describe("completePendingOnboardingContinuation", () => {
  it("redeems via the onboarding chat endpoint and clears the token on success", async () => {
    storePendingOnboardingSession(TOKEN);
    const post = vi.fn().mockResolvedValue({});
    const transport: OnboardingContinuationTransport = { post };

    await completePendingOnboardingContinuation(TOKEN, transport);

    expect(post).toHaveBeenCalledWith("/api/eliza-app/onboarding/chat", {
      sessionId: TOKEN,
      platform: "web",
      confirmPlatformLink: true,
    });
    expect(peekPendingOnboardingSession()).toBeNull();
  });

  it("keeps the token for retry when the redemption POST fails", async () => {
    storePendingOnboardingSession(TOKEN);
    const post = vi.fn().mockRejectedValue(new Error("503"));
    const transport: OnboardingContinuationTransport = { post };

    await expect(
      completePendingOnboardingContinuation(TOKEN, transport),
    ).rejects.toThrow("503");
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
  });

  it("silently ignores an unsanitizable token", async () => {
    const post = vi.fn();
    const transport: OnboardingContinuationTransport = { post };

    await completePendingOnboardingContinuation(
      "platform:discord:1",
      transport,
    );

    expect(post).not.toHaveBeenCalled();
  });
});
