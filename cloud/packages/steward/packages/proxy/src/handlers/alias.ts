/**
 * Named alias resolution.
 *
 * Resolves proxy request paths to target URLs:
 *   - Named alias:  /openai/v1/chat/completions → https://api.openai.com/v1/chat/completions
 *   - Direct proxy: /proxy/custom.api.com/endpoint → https://custom.api.com/endpoint
 *
 * Returns null if the path doesn't match any known pattern.
 */

import { DEFAULT_ALIASES } from "../config";

export interface ResolvedTarget {
  /** Full target URL including protocol */
  url: string;
  /** Just the hostname (for route matching) */
  host: string;
  /** Path on the target host */
  path: string;
}

/**
 * Resolve a proxy request path to a target URL.
 *
 * @param requestPath - The path from the incoming request (e.g. "/openai/v1/chat/completions")
 * @returns Resolved target or null if path doesn't match any alias or proxy pattern
 */
export function resolveTarget(requestPath: string): ResolvedTarget | null {
  // Strip leading slash and split into segments
  const cleaned = requestPath.startsWith("/") ? requestPath.slice(1) : requestPath;
  if (!cleaned) return null;

  const slashIdx = cleaned.indexOf("/");
  const firstSegment = slashIdx === -1 ? cleaned : cleaned.slice(0, slashIdx);
  const remainder = slashIdx === -1 ? "" : cleaned.slice(slashIdx);

  // 1. Check named aliases: /openai/... → api.openai.com/...
  const aliasHost = DEFAULT_ALIASES[firstSegment];
  if (aliasHost) {
    return {
      url: `https://${aliasHost}${remainder}`,
      host: aliasHost,
      path: remainder || "/",
    };
  }

  // 2. Direct proxy: /proxy/custom.api.com/endpoint → custom.api.com/endpoint
  if (firstSegment === "proxy") {
    const afterProxy = remainder.startsWith("/") ? remainder.slice(1) : remainder;
    if (!afterProxy) return null;

    const hostSlashIdx = afterProxy.indexOf("/");
    const host = hostSlashIdx === -1 ? afterProxy : afterProxy.slice(0, hostSlashIdx);
    const path = hostSlashIdx === -1 ? "/" : afterProxy.slice(hostSlashIdx);

    // Basic hostname validation
    if (!host.includes(".")) return null;

    return {
      url: `https://${host}${path}`,
      host,
      path,
    };
  }

  return null;
}

/**
 * Get all registered alias names.
 */
export function getAliasNames(): string[] {
  return Object.keys(DEFAULT_ALIASES);
}

/**
 * Check if a given name is a registered alias.
 */
export function isAlias(name: string): boolean {
  return name in DEFAULT_ALIASES;
}
