/**
 * Whether a sign-in made the user's organization.
 *
 * An app tells a person "Account created." or "Signed in." from this answer, so
 * it must come from server records, not from the client or a time window. The
 * answer is true when the organization was created at or after the moment the
 * sign-in started. Both values are fixed once the sign-in exists, so every retry
 * of the same sign-in gets the same answer.
 *
 * - A Steward session: the sign-in starts when Steward issues the session (`iat`).
 *   Cloud creates the organization on the first request of that session.
 * - A CLI login session: the sign-in starts when Cloud creates the session row.
 */

/**
 * Steward signs `iat` and the database stamps `created_at`: two clocks. A new
 * organization is created after its session is issued, so the allowance only
 * absorbs clock drift between them. An account made this little before a new
 * sign-in was made by that same sign-up.
 */
export const STEWARD_SESSION_CLOCK_ALLOWANCE_MS = 60_000;

export function organizationCreatedBySignIn(
  organizationCreatedAt: Date | string | null | undefined,
  signInStartedAtMs: number,
  clockAllowanceMs = 0,
): boolean {
  if (!organizationCreatedAt || !Number.isFinite(signInStartedAtMs) || signInStartedAtMs <= 0)
    return false;
  const created = new Date(organizationCreatedAt).getTime();
  return Number.isFinite(created) && created >= signInStartedAtMs - clockAllowanceMs;
}
