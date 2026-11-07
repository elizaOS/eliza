/** Shared browser/host session cookie and header names. No platform dependencies. */
export const SESSION_COOKIE_NAME = "eliza_session";
export const CSRF_COOKIE_NAME = "eliza_csrf";
export const CSRF_HEADER_NAME = "x-eliza-csrf";
/**
 * Epoch-ms time of the last real user interaction, sent on same-origin API
 * requests so an idle-timeout policy slides on user activity, not polling.
 */
export const LAST_ACTIVITY_HEADER_NAME = "x-eliza-last-activity";
