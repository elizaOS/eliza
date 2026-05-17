/**
 * Pure CORS allowlist helpers shared by the server and focused tests.
 *
 * Kept separate from server.ts so helper-only tests do not need to load the
 * full API runtime dependency graph.
 */
/**
 * Build the set of localhost ports allowed for CORS.
 * Reads from env vars at call time so tests can override.
 */
export declare function buildCorsAllowedPorts(): Set<string>;
/**
 * Comma-separated explicit origins allowed by the operator (e.g. a
 * remote dashboard host like https://bot.example.com). Localhost gets
 * a built-in pass via {@link isAllowedOrigin}; this is the only
 * way to allow non-loopback hosts.
 */
export declare function getAllowedRemoteOrigins(): Set<string>;
export declare function getCorsAllowedPorts(): Set<string>;
export declare function getCachedRemoteOrigins(): Set<string>;
/** Invalidate the cached CORS port set so it is recomputed on next request. */
export declare function invalidateCorsAllowedPorts(): void;
/**
 * Check whether a URL string is an allowed origin for CORS:
 *   - a configured local API port,
 *   - a Capacitor / Ionic WebView origin (mobile app builds),
 *   - or an explicit operator-allowed remote origin.
 */
export declare function isAllowedOrigin(
  urlStr: string,
  allowedPorts?: Set<string>,
  allowedRemoteOrigins?: Set<string>,
): boolean;
//# sourceMappingURL=server-cors.d.ts.map
