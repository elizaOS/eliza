/**
 * Pure route-matching functions.
 *
 * Extracted from proxy.ts so they can be unit-tested without DB dependencies.
 */

/**
 * Match a host pattern against a hostname.
 * Supports exact match and wildcard prefix: *.example.com
 */
export function matchHost(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return false;
}

/**
 * Match a path pattern against a request path.
 * Supports exact match and wildcard suffix: /v1/*
 * The pattern "/*" matches everything.
 */
export function matchPath(pattern: string, path: string): boolean {
  if (pattern === "/*" || pattern === "*") return true;
  if (pattern === path) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // "/v1/"
    return path.startsWith(prefix) || path === pattern.slice(0, -2);
  }
  return false;
}
