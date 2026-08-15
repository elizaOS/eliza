/**
 * Request body construction for the shared-onboarding provisioning poll.
 * Extracted from the React hook so the polling request contract (statusOnly,
 * platform derivation, no user message) is covered by unit tests without a
 * full React hook test harness.
 */

/**
 * Builds the request body for a shared-onboarding status poll. The polling
 * effect calls this immediately and every 5 s so repeated polls cannot grow
 * the durable transcript with duplicate status copy.
 */
export function buildProvisioningPollBody(
  onboardingSessionId?: string | null,
): { sessionId?: string; platform: string; statusOnly: true } {
  return {
    sessionId: onboardingSessionId ?? undefined,
    platform: onboardingSessionId ? "blooio" : "web",
    statusOnly: true,
  };
}
