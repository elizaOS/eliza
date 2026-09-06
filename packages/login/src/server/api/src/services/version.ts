/**
 * Exposes the login API protocol version without loading the request context.
 * Audit signing also consumes this value in maintenance scripts and tests.
 */
export const API_VERSION = process.env.API_VERSION || "0.3.0";
