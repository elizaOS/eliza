/**
 * Entry-step resolution for platform onboarding continuations on /get-started.
 *
 * A visitor who lands with an `onboardingSession` query parameter came from a
 * platform chat (Discord DM "Connect" button, SMS link). They already chose
 * their platform, so the connector picker is never the right destination:
 * signed-in visitors continue into the identity-link handoff (Discord
 * sessions confirm the link and are prompted back to Discord; other platform
 * sessions fall back to the web provisioning chat), signed-out visitors go
 * straight to sign-in. Kept as a pure function so the routing contract is
 * directly unit-testable outside the page component.
 */

export type OnboardingEntryStep = "CONTINUATION_LINK" | "ONBOARDING_SIGN_IN";

export interface OnboardingEntryInput {
  /** `onboardingSession` query parameter (or restored continuation). */
  onboardingSessionId: string | null;
  isAuthenticated: boolean;
  /** Account-linking flows keep their existing method-specific steps. */
  isLinkMode: boolean;
  /** Discord OAuth callback `code` — the callback step must handle it. */
  discordCode: string | null;
  /** Explicit `method` parameter (Telegram continuations set method=telegram). */
  methodParam: string | null;
}

/**
 * Returns the step a platform continuation should land on, or null when the
 * visit is not a continuation this function owns (no session id, link mode,
 * an in-flight OAuth callback, or an explicit method override).
 */
export function resolveOnboardingEntryStep(
  input: OnboardingEntryInput,
): OnboardingEntryStep | null {
  if (!input.onboardingSessionId || input.isLinkMode) return null;
  if (input.isAuthenticated) return "CONTINUATION_LINK";
  if (input.discordCode || input.methodParam) return null;
  return "ONBOARDING_SIGN_IN";
}
