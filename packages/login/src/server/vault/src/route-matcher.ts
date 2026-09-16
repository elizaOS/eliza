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

import { and, eq } from "drizzle-orm";
import { getDb, type SecretRoute, secretRoutes } from "../../db/src/index.ts";

export interface MatchedRoute {
  route: SecretRoute;
  secretId: string;
  injectAs: string;
  injectKey: string;
  injectFormat: string;
  injectionStrategy: "header" | "sigv4";
  injectionConfig: { service?: string; region?: string };
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports `*` as a wildcard.
 * E.g. `*.anthropic.com` → /^.+\.anthropic\.com$/
 *      `/v1/*` → /^\/v1\/.+$/
 */
export function globToRegex(pattern: string): RegExp {
  if (pattern === "*") return /^.*$/;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  return new RegExp(`^${escaped}$`);
}

/**
 * Check if a value matches a glob pattern.
 */
export function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("/*")) return value.startsWith(pattern.slice(0, -1));
  return globToRegex(pattern).test(value);
}

function hostSpecificity(pattern: string): number {
  if (pattern === "*") return 0;
  if (pattern.startsWith("*.")) return 100 + pattern.length;
  return 1_000 + pattern.length;
}

function pathSpecificity(pattern: string | null | undefined): number {
  const value = pattern ?? "/*";
  if (value === "*" || value === "/*") return 0;
  if (value.endsWith("/*")) return 100 + value.length;
  return 1_000 + value.length;
}

function methodSpecificity(method: string | null | undefined): number {
  return method && method !== "*" ? 1 : 0;
}

function createdAtMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function compareRouteMatchSpecificity(a: SecretRoute, b: SecretRoute): number {
  const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
  if (priorityDelta !== 0) return priorityDelta;

  const hostDelta =
    hostSpecificity(b.hostPattern) - hostSpecificity(a.hostPattern);
  if (hostDelta !== 0) return hostDelta;

  const pathDelta =
    pathSpecificity(b.pathPattern) - pathSpecificity(a.pathPattern);
  if (pathDelta !== 0) return pathDelta;

  const methodDelta = methodSpecificity(b.method) - methodSpecificity(a.method);
  if (methodDelta !== 0) return methodDelta;

  const createdDelta = createdAtMs(a.createdAt) - createdAtMs(b.createdAt);
  if (createdDelta !== 0) return createdDelta;

  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/**
 * Find all matching routes for a given request, sorted by priority (highest first).
 */
export async function findMatchingRoutes(
  tenantId: string,
  agentId: string,
  host: string,
  path: string,
  method: string,
): Promise<MatchedRoute[]> {
  const db = getDb();

  // Fetch all enabled routes for this tenant
  const routes = await db
    .select()
    .from(secretRoutes)
    .where(
      and(
        eq(secretRoutes.tenantId, tenantId),
        eq(secretRoutes.agentId, agentId),
        eq(secretRoutes.enabled, true),
      ),
    );

  const matches: MatchedRoute[] = [];

  for (const route of routes) {
    // Check host pattern
    if (!matchesGlob(host, route.hostPattern)) continue;

    // Check path pattern
    if (
      route.pathPattern &&
      route.pathPattern !== "/*" &&
      !matchesGlob(path, route.pathPattern)
    )
      continue;

    // Check method
    if (
      route.method &&
      route.method !== "*" &&
      route.method.toUpperCase() !== method.toUpperCase()
    )
      continue;

    matches.push({
      route,
      secretId: route.secretId,
      injectAs: route.injectAs,
      injectKey: route.injectKey,
      injectFormat: route.injectFormat ?? "{value}",
      injectionStrategy: route.injectionStrategy as "header" | "sigv4",
      injectionConfig: route.injectionConfig,
    });
  }

  matches.sort((a, b) => compareRouteMatchSpecificity(a.route, b.route));

  return matches;
}

/**
 * Find the single best matching route (highest priority).
 * Returns null if no route matches.
 */
export async function findMatchingRoute(
  tenantId: string,
  agentId: string,
  host: string,
  path: string,
  method: string,
): Promise<MatchedRoute | null> {
  const matches = await findMatchingRoutes(
    tenantId,
    agentId,
    host,
    path,
    method,
  );
  return matches[0] ?? null;
}
