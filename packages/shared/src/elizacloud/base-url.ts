/**
 * Pure URL normalizer for Eliza Cloud site/API base URLs. No host-layer deps.
 */

import { readAliasedEnv } from "../utils/env.js";
import {
  classifyElizaHostname,
  ELIZA_DOMAIN_CONTRACTS,
  type ElizaCloudEnvironment,
} from "./domain-contract.js";

const PRODUCTION_CLOUD_SITE_URL =
  ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin;
const STAGING_CLOUD_SITE_URL = ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin;

/**
 * True when this process was started from the repo's dev entrypoint.
 *
 * `bun run dev` sets `ELIZA_DEV_SOURCE=1` (root `package.json`) and nothing
 * else does; `bun run start` sets neither it nor `NODE_ENV=development`. We key
 * on the explicit flag rather than `NODE_ENV` because `NODE_ENV=development`
 * is set by many harnesses (tests, benchmarks, tooling) that should keep
 * talking to whatever cloud they were configured for.
 */
export function isDevCloudTarget(): boolean {
  return readAliasedEnv("ELIZA_DEV_SOURCE") === "1";
}

/**
 * The Eliza Cloud deployment an unconfigured process talks to: **staging from
 * `bun run dev`, production otherwise**.
 *
 * Local development must not exercise production credentials, billing, or agent
 * state by default. `ELIZAOS_CLOUD_BASE_URL` still overrides this in either
 * direction (see `normalizeCloudSiteUrl`), so pointing a dev run at production
 * — or a deployed process at staging — stays a one-variable change.
 *
 * Staging is a separate deployment with its own database and its own API keys:
 * a production `ELIZAOS_CLOUD_API_KEY` does NOT authenticate against it. Mint a
 * staging key with `eliza auth dev-login --cloud https://api-staging.eliza.app`.
 */
export function defaultCloudSiteUrl(): string {
  return isDevCloudTarget()
    ? STAGING_CLOUD_SITE_URL
    : PRODUCTION_CLOUD_SITE_URL;
}

function controlPlaneEnvironment(
  hostname: string,
): ElizaCloudEnvironment | null {
  const classified = classifyElizaHostname(hostname);
  switch (classified.role) {
    case "marketing":
    case "cloud-app":
    case "cloud-api":
    case "legacy-marketing":
    case "legacy-cloud-app":
    case "legacy-cloud-api":
      return classified.environment;
    default:
      return null;
  }
}

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
  const candidate = envOverride || rawUrl?.trim() || defaultCloudSiteUrl();

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

    const environment = controlPlaneEnvironment(host);
    if (environment) {
      parsed.hostname = new URL(
        ELIZA_DOMAIN_CONTRACTS[environment].cloudAppOrigin,
      ).hostname;
      parsed.pathname = "";
    }

    return parsed.toString().replace(/\/{1,1024}$/, "");
  } catch {
    return normalizeMalformedCandidate(candidate);
  }
}

export function resolveCloudApiBaseUrl(rawUrl?: string): string {
  const siteUrl = normalizeCloudSiteUrl(rawUrl);
  try {
    const parsed = new URL(siteUrl);
    const environment = controlPlaneEnvironment(parsed.hostname);
    if (environment) {
      return `${ELIZA_DOMAIN_CONTRACTS[environment].cloudApiOrigin}/api/v1`;
    }
  } catch {
    // error-policy:J3 malformed normalized input retains the sanitized custom
    // base contract; the caller receives an explicit URL-like string, not a
    // fabricated canonical environment.
  }
  return `${siteUrl}/api/v1`;
}
