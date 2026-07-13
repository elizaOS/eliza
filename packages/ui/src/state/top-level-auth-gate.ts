/**
 * Whether the main shell should stay unmounted while the top-level auth probe is
 * still deciding. This applies to first-run too: onboarding can wait for the
 * public auth probe, while mounting shell stores early fans protected requests
 * out into avoidable 401s.
 */
export function authProbeShouldHoldShell(authPhase: string): boolean {
  return authPhase === "loading";
}
