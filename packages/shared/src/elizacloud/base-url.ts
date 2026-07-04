/**
 * Pure URL normalizer for Eliza Cloud site/API base URLs. No host-layer deps.
 */

import { readAliasedEnv } from "../utils/env.js";

const DEFAULT_CLOUD_SITE_URL = "https://elizacloud.ai";

const LEGACY_CLOUD_HOST_ALIASES = new Set([
  "api.elizacloud.ai",
  "elizacloud.ai",
  "www.elizacloud.ai",
]);

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.")
  );
}

function trimApiPath(pathname: string): string {
  const normalized = pathname.trim().replace(/\/+$/, "");
  if (!normalized) return "";
  if (normalized === "/api/v1") return "";
  if (normalized.endsWith("/api/v1")) {
    return normalized.slice(0, -"/api/v1".length);
  }
  return normalized;
}

function normalizeMalformedCandidate(candidate: string): string {
  const truncated =
    candidate.length > 8192 ? candidate.slice(0, 8192) : candidate;
  const withoutFragment = truncated.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
  const withoutApiPath = withoutQuery.replace(/\/api\/v1\/?$/i, "");
  const withoutTrailingSlash = withoutApiPath.replace(/\/{1,1024}$/, "");
  return withoutTrailingSlash.replace(/^http:\/\//i, "https://");
}

export function normalizeCloudSiteUrl(rawUrl?: string): string {
  // Allow cloud-provisioned containers to override the base URL via env var
  const envOverride = readAliasedEnv("ELIZAOS_CLOUD_BASE_URL");
  const candidate = envOverride || rawUrl?.trim() || DEFAULT_CLOUD_SITE_URL;

  try {
    const parsed = new URL(candidate);
    const pathname = trimApiPath(parsed.pathname);
    const host = parsed.hostname.toLowerCase();
    const preserveLocalOrigin = isLoopbackHost(host);

    parsed.hash = "";
    parsed.search = "";
    if (!preserveLocalOrigin) {
      parsed.protocol = "https:";
      parsed.port = "";
    }
    parsed.pathname = pathname;

    if (LEGACY_CLOUD_HOST_ALIASES.has(host)) {
      parsed.hostname = "elizacloud.ai";
      parsed.pathname = "";
    }

    return parsed.toString().replace(/\/{1,1024}$/, "");
  } catch {
    return normalizeMalformedCandidate(candidate);
  }
}

export function resolveCloudApiBaseUrl(rawUrl?: string): string {
  return `${normalizeCloudSiteUrl(rawUrl)}/api/v1`;
}
