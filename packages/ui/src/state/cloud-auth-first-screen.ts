/** Carries the one-shot greeting handoff across the Cloud login navigation. */

import { shellLocalStorage } from "../surface-realm-channel";

export const CLOUD_AUTH_FIRST_SCREEN_GREETING_KEY =
  "eliza:cloud-auth-first-screen-greeting";

/** Mark an interactive first-run login whose agent should greet after setup. */
export function markCloudAuthFirstScreenGreeting(): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.setItem(CLOUD_AUTH_FIRST_SCREEN_GREETING_KEY, "1");
  } catch {
    // error-policy:J4 storage loss affects only the optional greeting handoff.
  }
}

/** Clear the handoff when authentication fails before a session is installed. */
export function clearCloudAuthFirstScreenGreeting(): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.removeItem(CLOUD_AUTH_FIRST_SCREEN_GREETING_KEY);
  } catch {
    // error-policy:J4 blocked storage cannot retain a marker that was not writable.
  }
}

/** Consume the greeting handoff exactly once after Cloud auth succeeds. */
export function consumeCloudAuthFirstScreenGreeting(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const pending =
      window.localStorage.getItem(CLOUD_AUTH_FIRST_SCREEN_GREETING_KEY) === "1";
    if (pending) {
      shellLocalStorage.removeItem(CLOUD_AUTH_FIRST_SCREEN_GREETING_KEY);
    }
    return pending;
  } catch {
    // error-policy:J3 blocked storage is an explicit absent marker.
    return false;
  }
}
