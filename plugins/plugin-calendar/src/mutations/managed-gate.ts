/**
 * Deleting or cancelling an event on a managed Google Calendar depends on a
 * separately owned production host service that is not yet qualified. It stays
 * off unless the host explicitly sets this flag. Creates and updates are
 * unaffected; every managed write still requires an approved owner review.
 */
export const MANAGED_CALENDAR_DELETE_FLAG =
  "ELIZA_MANAGED_CALENDAR_DELETE_ENABLED";
export const MANAGED_CALENDAR_DELETE_UNAVAILABLE =
  "CALENDAR_MANAGED_DELETE_UNAVAILABLE";
export const isManagedCalendarGrant = (v: unknown): v is string =>
  typeof v === "string" && /^alpha-google:[a-f0-9]{64}$/.test(v);
export function managedCalendarDeleteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[MANAGED_CALENDAR_DELETE_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true";
}
