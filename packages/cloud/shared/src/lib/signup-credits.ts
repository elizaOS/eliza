/**
 * Signup welcome-credit amount.
 *
 * Lives in its own module (not steward-sync.ts) so services that steward-sync
 * itself imports — e.g. the invites service, which compares a solo org's
 * balance against the grant (#11332) — can read it without an import cycle.
 */

export const DEFAULT_INITIAL_CREDITS = 5.0;

export const getInitialCredits = (): number => {
  const envValue = process.env.INITIAL_FREE_CREDITS;
  if (envValue) {
    const parsed = parseFloat(envValue);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_INITIAL_CREDITS;
};
