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

  test("authenticated continuation continues into the identity-link handoff", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: true,
        isLinkMode: false,
        discordCode: null,
        methodParam: null,
      }),
    ).toBe("CONTINUATION_LINK");
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

  test("authentication outranks an in-flight Discord OAuth callback", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: true,
        isLinkMode: false,
        discordCode: "oauth-code",
        methodParam: null,
      }),
    ).toBe("CONTINUATION_LINK");
  });

  test("authentication outranks an explicit method override", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: true,
        isLinkMode: false,
        discordCode: null,
        methodParam: "telegram",
      }),
    ).toBe("CONTINUATION_LINK");
  });

  test("an empty session id is not a continuation", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: "",
        isAuthenticated: false,
        isLinkMode: false,
        discordCode: null,
        methodParam: null,
      }),
    ).toBeNull();
  });

  test("unauthenticated link mode never lands on sign-in", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: false,
        isLinkMode: true,
        discordCode: null,
        methodParam: null,
      }),
    ).toBeNull();
  });

  test("an empty Discord code does not divert a signed-out continuation", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: false,
        isLinkMode: false,
        discordCode: "",
        methodParam: null,
      }),
    ).toBe("ONBOARDING_SIGN_IN");
  });

  test("an empty method parameter does not divert a signed-out continuation", () => {
    expect(
      resolveOnboardingEntryStep({
        onboardingSessionId: SESSION,
        isAuthenticated: false,
        isLinkMode: false,
        discordCode: null,
        methodParam: "",
      }),
    ).toBe("ONBOARDING_SIGN_IN");
  });
});
