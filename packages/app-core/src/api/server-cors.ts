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
export function buildCorsAllowedPorts(): Set<string> {
  const ports = new Set([
    String(process.env.ELIZA_API_PORT ?? process.env.ELIZA_PORT ?? "31337"),
    String(process.env.ELIZA_PORT ?? "2138"),
    String(process.env.ELIZA_GATEWAY_PORT ?? "18789"),
    String(process.env.ELIZA_HOME_PORT ?? "2142"),
  ]);
  // Electrobun renderer static server picks a free port in the 5174–5200
  // range. Allow the full range so cross-origin fetches from WKWebView
  // to the local API succeed.
  for (let p = 5174; p <= 5200; p++) ports.add(String(p));
  return ports;
}

/** Lazily cached port set — computed once, invalidated on port changes. */
let cachedCorsAllowedPorts: Set<string> | undefined;

export function getCorsAllowedPorts(): Set<string> {
  if (!cachedCorsAllowedPorts) {
    cachedCorsAllowedPorts = buildCorsAllowedPorts();
  }
  return cachedCorsAllowedPorts;
}

/** Invalidate the cached CORS port set so it is recomputed on next request. */
export function invalidateCorsAllowedPorts(): void {
  cachedCorsAllowedPorts = undefined;
}

/**
 * Check whether a URL string is an allowed localhost origin for CORS.
 */
export function isAllowedLocalOrigin(
  urlStr: string,
  allowedPorts?: Set<string>,
): boolean {
  const ports = allowedPorts ?? buildCorsAllowedPorts();
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    const isLocal =
      h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return isLocal && ports.has(port);
  } catch {
    return false;
  }
}
