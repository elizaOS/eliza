/**
 * Routing contract for platform onboarding continuations on /get-started.
 *
 * Repro (Shadow, 2026-08-11): DM the Discord bot -> tap Connect ->
 * /get-started/?onboardingSession=<id> while signed out rendered the
 * "Anywhere you want her to be." connector picker. The visitor already came
 * FROM Discord, so being asked to pick a platform is a dead end — an
 * unauthenticated continuation must land directly on sign-in, and an
 * authenticated one must resume the provisioning chat.
 */
import { describe, expect, test } from "bun:test";
import { resolveOnboardingEntryStep } from "../src/lib/onboarding-continuation";

const SESSION = "0f5f9f9a-72cf-45e1-b1a1-2b7f9b1de111";

describe("resolveOnboardingEntryStep", () => {
  test("unauthenticated continuation lands on sign-in, never the connector picker", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: false,
        isLinkMode: false,
        discordCode: null,
        methodParam: null,
      }),
    ).toBe("ONBOARDING_SIGN_IN");
  });

  test("authenticated continuation resumes the provisioning chat", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: true,
        isLinkMode: false,
        discordCode: null,
        methodParam: null,
      }),
    ).toBe("PROVISIONING_CHAT");
  });

  test("no continuation id keeps the default flow (picker)", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: null,
        isAuthenticated: false,
        isLinkMode: false,
        discordCode: null,
        methodParam: null,
      }),
    ).toBeNull();
  });

  test("an in-flight Discord OAuth callback is owned by the callback step", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: false,
        isLinkMode: false,
        discordCode: "oauth-code",
        methodParam: null,
      }),
    ).toBeNull();
  });

  test("explicit method continuations (Telegram) keep their method flow", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: false,
        isLinkMode: false,
        discordCode: null,
        methodParam: "telegram",
      }),
    ).toBeNull();
  });

  test("link mode never re-routes", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: true,
        isLinkMode: true,
        discordCode: null,
        methodParam: null,
      }),
    ).toBeNull();
  });
});
