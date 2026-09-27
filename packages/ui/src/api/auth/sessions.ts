/**
 * Client-side auth constants (session/CSRF cookie + header names) shared with
 * the node auth implementation in @elizaos/app, which re-exports these (single
 * source). Keep this module dependency-free: the Node host imports it.
 */
export const SESSION_COOKIE_NAME = "eliza_session";
export const CSRF_COOKIE_NAME = "eliza_csrf";
export const CSRF_HEADER_NAME = "x-eliza-csrf";
