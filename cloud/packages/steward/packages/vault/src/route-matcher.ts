/**
 * Route Matcher — finds matching secret routes for incoming proxy requests.
 *
 * Supports glob patterns for host and path matching:
 *   - `*.anthropic.com` matches `api.anthropic.com`
 *   - `/v1/*` matches `/v1/chat/completions`
 *   - `*` matches everything
 *
 * When multiple routes match, returns the one with the highest priority.
 */

import { getDb, type SecretRoute, secretRoutes } from "@stwd/db";
import { and, eq } from "drizzle-orm";

export interface MatchedRoute {
  route: SecretRoute;
  secretId: string;
  injectAs: string;
  injectKey: string;
  injectFormat: string;
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports `*` as a wildcard for one or more characters.
 * E.g. `*.anthropic.com` → /^.+\.anthropic\.com$/
 *      `/v1/*` → /^\/v1\/.+$/
 */
export function globToRegex(pattern: string): RegExp {
  if (pattern === "*") return /^.*$/;

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

  return new RegExp(`^${escaped}$`);
}

/**
 * Check if a value matches a glob pattern.
 */
export function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return globToRegex(pattern).test(value);
}

/**
 * Find all matching routes for a given request, sorted by priority (highest first).
 */
export async function findMatchingRoutes(
  tenantId: string,
  host: string,
  path: string,
  method: string,
): Promise<MatchedRoute[]> {
  const db = getDb();

  // Fetch all enabled routes for this tenant
  const routes = await db
    .select()
    .from(secretRoutes)
    .where(and(eq(secretRoutes.tenantId, tenantId), eq(secretRoutes.enabled, true)));

  const matches: MatchedRoute[] = [];

  for (const route of routes) {
    // Check host pattern
    if (!matchesGlob(host, route.hostPattern)) continue;

    // Check path pattern
    if (route.pathPattern && route.pathPattern !== "/*" && !matchesGlob(path, route.pathPattern))
      continue;

    // Check method
    if (route.method && route.method !== "*" && route.method.toUpperCase() !== method.toUpperCase())
      continue;

    matches.push({
      route,
      secretId: route.secretId,
      injectAs: route.injectAs,
      injectKey: route.injectKey,
      injectFormat: route.injectFormat ?? "{value}",
    });
  }

  // Sort by priority descending (highest priority first)
  matches.sort((a, b) => (b.route.priority ?? 0) - (a.route.priority ?? 0));

  return matches;
}

/**
 * Find the single best matching route (highest priority).
 * Returns null if no route matches.
 */
export async function findMatchingRoute(
  tenantId: string,
  host: string,
  path: string,
  method: string,
): Promise<MatchedRoute | null> {
  const matches = await findMatchingRoutes(tenantId, host, path, method);
  return matches[0] ?? null;
}
