/**
 * Build-time gate for The Network home page on eliza.app.
 *
 * Off unless the web build sets `VITE_NETWORK_HOME=1`. It pairs with the Cloud
 * gateway's `NETWORK_TAKEOVER` flag (thenetwork docs/go-live-handoff.md
 * section 7): both stay off until the founder approves the wording and the
 * takeover. With the flag off the apex `/` route keeps its current behavior.
 */
export function isNetworkHomeEnabled(
  env: Record<string, unknown> | undefined,
): boolean {
  return env?.VITE_NETWORK_HOME === "1";
}

// Literal access so Vite inlines the value and drops the page from builds
// that leave the flag unset.
export const NETWORK_HOME_ENABLED: boolean =
  import.meta.env?.VITE_NETWORK_HOME === "1";
