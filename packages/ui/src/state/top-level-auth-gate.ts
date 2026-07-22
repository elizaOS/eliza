/**
 * Whether onboarding owns the sign-in surface, so App's top-level `LoginView`
 * auth gate must yield.
 *
 * The in-chat first-run conductor seeds the Cloud OAuth block while onboarding
 * runs, so it is the login surface during first-run. App's top-level
 * `LoginView` must NOT also mount then — or the user sees the login widget
 * TWICE during onboarding.
 *
 * The gate was bypassed only for `startupCoordinator.phase ===
 * "first-run-required"`, but the conductor stays active on a SEPARATE signal
 * (`firstRunComplete === false`). When the two disagree — the coordinator has
 * advanced past `first-run-required` while onboarding is still incomplete (e.g.
 * a cloud pick moved startup into a provisioning/hydrating phase while the
 * conductor's cloud-OAuth block is still up) — both login surfaces mounted.
 *
 * Yield whenever EITHER signal says onboarding is active. Only an explicit
 * `firstRunComplete === false` counts as active: a loading (`undefined` / not
 * yet known) or completed (`true`) state must NOT suppress the gate, so a
 * normal unauthenticated session still gets the top-level login.
 */
export function firstRunOwnsLoginSurface(
  coordinatorPhase: string,
  firstRunComplete: boolean | null | undefined,
): boolean {
  return (
    coordinatorPhase === "first-run-required" || firstRunComplete === false
  );
}

/**
 * Whether App's top-level auth gate owns the current surface. A resolved 401
 * may override first-run for real agent backends, but never for the agentless
 * Cloud app origin whose first-run conductor is the Cloud login surface.
 */
export function topLevelAuthGateOwnsSurface(
  coordinatorPhase: string,
  firstRunComplete: boolean | null | undefined,
  authPhase: string,
  isAgentlessCloudOrigin: boolean,
): boolean {
  return (
    !firstRunOwnsLoginSurface(coordinatorPhase, firstRunComplete) ||
    (authPhase === "unauthenticated" && !isAgentlessCloudOrigin)
  );
}

/**
 * Whether the main shell should stay unmounted while the top-level auth probe is
 * still deciding. Returning users with an expired Cloud session can have a
 * persisted agent base in localStorage; mounting the shell before `/api/auth/me`
 * resolves starts agent/status/chat pollers that all 401. First-run still owns
 * its in-chat login surface, so this only applies to normal post-onboarding
 * sessions.
 */
export function authProbeShouldHoldShell(
  coordinatorPhase: string,
  firstRunComplete: boolean | null | undefined,
  authPhase: string,
): boolean {
  return (
    authPhase === "loading" &&
    !firstRunOwnsLoginSurface(coordinatorPhase, firstRunComplete)
  );
}

/**
 * Cloud-provisioned containers with no bootstrap bearer use the full-screen
 * startup shell's BootstrapStep. `first-run-required` is normally paintable so
 * in-chat onboarding can run; this narrower state must override that normal
 * rule or the main shell/top-level LoginView hides the bootstrap token gate.
 */
export function bootstrapOwnsStartupSurface(
  coordinatorPhase: string,
  firstRunComplete: boolean | null | undefined,
  firstRunCloudProvisionedContainer: boolean,
  bootstrapSessionNeeded: boolean,
): boolean {
  return (
    coordinatorPhase === "first-run-required" &&
    firstRunComplete === false &&
    firstRunCloudProvisionedContainer &&
    bootstrapSessionNeeded
  );
}

/** Safe browser-storage probe shared by App's paint gate and the controller. */
export function needsBootstrapSession(): boolean {
  try {
    return !sessionStorage.getItem("eliza_session");
  } catch {
    // error-policy:J3 storage can be unavailable in privacy mode. Requiring
    // bootstrap is the fail-closed branch; skipping it could expose a shell
    // with no bearer.
    return true;
  }
}
