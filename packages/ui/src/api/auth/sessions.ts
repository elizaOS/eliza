/**
 * Client-side auth constants (session/CSRF cookie + header names) shared with
 * the node auth implementation in @elizaos/app, which re-exports these (single
 * source). Keep this module dependency-free: the Node host imports it.
 */
export const SESSION_COOKIE_NAME = "eliza_session";
export const CSRF_COOKIE_NAME = "eliza_csrf";
export const CSRF_HEADER_NAME = "x-eliza-csrf";
/**
 * Epoch-ms time of the last real user interaction, sent on same-origin API
 * requests so an idle-timeout policy slides on user activity, not polling.
 */
export const LAST_ACTIVITY_HEADER_NAME = "x-eliza-last-activity";
