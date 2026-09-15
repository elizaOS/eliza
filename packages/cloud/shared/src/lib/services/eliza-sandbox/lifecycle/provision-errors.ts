/** Represents unresolved sandbox reachability that must preserve retry authority rather than provisioning a duplicate. */

/**
 * Thrown when post-create readiness cannot establish the required managed
 * reachability: either every SSH probe failed, or SSH proved the workload
 * healthy while its tailnet ingress remained unavailable. The provision path
 * keeps the container in place and returns a RETRYABLE failure instead of
 * tearing down a healthy or unproven workload (#15310 failure mode #6).
 */
export class SandboxReachabilityUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxReachabilityUnresolvedError";
  }
}

/**
 * Distinguishable prefix for the C1b attribution-guard failure. Chosen so it can
 * NEVER collide with the port-collision retry classifier in provision()'s catch
 * (which matches "23505" / "unique" / "duplicate") — metadata drift is a
 * permanent-ish condition, so this failure must classify as NON-retryable and
 * fall through to markError, not spin the retry loop.
 */
export const PROVISION_ATTRIBUTION_GUARD_PREFIX = "provision attribution guard:";
