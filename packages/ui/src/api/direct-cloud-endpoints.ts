/**
 * Canonicalizes Eliza marketing/auth, managed Cloud app, and API endpoints.
 * Browser login, management navigation, and API transport deliberately use
 * different hosts, with production and staging aliases resolved here.
 */

import {
  ELIZA_DOMAIN_CONTRACTS,
  LEGACY_ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/shared/elizacloud";

export const DEFAULT_DIRECT_CLOUD_BASE_URL =
  ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin;
export const DEFAULT_DIRECT_CLOUD_APP_BASE_URL =
  ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin;
export const DEFAULT_DIRECT_CLOUD_API_BASE_URL =
  ELIZA_DOMAIN_CONTRACTS.production.cloudApiOrigin;
export const STAGING_DIRECT_CLOUD_BASE_URL =
  ELIZA_DOMAIN_CONTRACTS.staging.marketingOrigin;
export const STAGING_DIRECT_CLOUD_APP_BASE_URL =
  ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin;
export const STAGING_DIRECT_CLOUD_API_BASE_URL =
  ELIZA_DOMAIN_CONTRACTS.staging.cloudApiOrigin;

/**
 * The app origin that pairs with a resolved canonical API origin. Sign-in has
 * to land on the app for the environment the session was minted against — a
 * staging build sending users to the production login mints a session on
 * staging that production cannot claim, so the flow fails with no useful error.
 */
export function directCloudAppBaseForApi(apiBaseUrl: string): string {
  return apiBaseUrl === STAGING_DIRECT_CLOUD_API_BASE_URL
    ? STAGING_DIRECT_CLOUD_APP_BASE_URL
    : DEFAULT_DIRECT_CLOUD_APP_BASE_URL;
}

export const DIRECT_ELIZA_CLOUD_API_BY_HOST = new Map([
  ["api.eliza.app", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["eliza.app", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["cloud.eliza.app", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["api-staging.eliza.app", STAGING_DIRECT_CLOUD_API_BASE_URL],
  ["staging.eliza.app", STAGING_DIRECT_CLOUD_API_BASE_URL],
  ["cloud-staging.eliza.app", STAGING_DIRECT_CLOUD_API_BASE_URL],
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.marketingHostnames.map(
    (hostname) => [hostname, DEFAULT_DIRECT_CLOUD_API_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudAppHostnames.map(
    (hostname) => [hostname, DEFAULT_DIRECT_CLOUD_API_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudApiHostnames.map(
    (hostname) => [hostname, DEFAULT_DIRECT_CLOUD_API_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.marketingHostnames.map(
    (hostname) => [hostname, STAGING_DIRECT_CLOUD_API_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudAppHostnames.map(
    (hostname) => [hostname, STAGING_DIRECT_CLOUD_API_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudApiHostnames.map(
    (hostname) => [hostname, STAGING_DIRECT_CLOUD_API_BASE_URL] as const,
  ),
]);

const DIRECT_ELIZA_CLOUD_WEB_BY_HOST = new Map([
  ["api.eliza.app", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["eliza.app", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["cloud.eliza.app", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["api-staging.eliza.app", STAGING_DIRECT_CLOUD_BASE_URL],
  ["staging.eliza.app", STAGING_DIRECT_CLOUD_BASE_URL],
  ["cloud-staging.eliza.app", STAGING_DIRECT_CLOUD_BASE_URL],
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.marketingHostnames.map(
    (hostname) => [hostname, DEFAULT_DIRECT_CLOUD_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudAppHostnames.map(
    (hostname) => [hostname, DEFAULT_DIRECT_CLOUD_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudApiHostnames.map(
    (hostname) => [hostname, DEFAULT_DIRECT_CLOUD_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.marketingHostnames.map(
    (hostname) => [hostname, STAGING_DIRECT_CLOUD_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudAppHostnames.map(
    (hostname) => [hostname, STAGING_DIRECT_CLOUD_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudApiHostnames.map(
    (hostname) => [hostname, STAGING_DIRECT_CLOUD_BASE_URL] as const,
  ),
]);

const DIRECT_ELIZA_CLOUD_APP_BY_HOST = new Map([
  ["api.eliza.app", DEFAULT_DIRECT_CLOUD_APP_BASE_URL],
  ["eliza.app", DEFAULT_DIRECT_CLOUD_APP_BASE_URL],
  ["cloud.eliza.app", DEFAULT_DIRECT_CLOUD_APP_BASE_URL],
  ["api-staging.eliza.app", STAGING_DIRECT_CLOUD_APP_BASE_URL],
  ["staging.eliza.app", STAGING_DIRECT_CLOUD_APP_BASE_URL],
  ["cloud-staging.eliza.app", STAGING_DIRECT_CLOUD_APP_BASE_URL],
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.marketingHostnames.map(
    (hostname) => [hostname, DEFAULT_DIRECT_CLOUD_APP_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudAppHostnames.map(
    (hostname) => [hostname, DEFAULT_DIRECT_CLOUD_APP_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudApiHostnames.map(
    (hostname) => [hostname, DEFAULT_DIRECT_CLOUD_APP_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.marketingHostnames.map(
    (hostname) => [hostname, STAGING_DIRECT_CLOUD_APP_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudAppHostnames.map(
    (hostname) => [hostname, STAGING_DIRECT_CLOUD_APP_BASE_URL] as const,
  ),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudApiHostnames.map(
    (hostname) => [hostname, STAGING_DIRECT_CLOUD_APP_BASE_URL] as const,
  ),
]);

/** Removes one trailing slash run with a single scan and allocation. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

export function resolveDirectCloudWebBase(cloudBase: string): string {
  const normalized = stripTrailingSlashes(cloudBase);
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return DIRECT_ELIZA_CLOUD_WEB_BY_HOST.get(host) ?? normalized;
  } catch {
    // error-policy:J3 malformed configured URLs remain explicit unchanged
    // input; the eventual navigation boundary will reject them.
    return normalized;
  }
}

/** Resolve the browser origin that owns authenticated Cloud management. */
export function resolveDirectCloudAppBase(cloudBase: string): string {
  const normalized = stripTrailingSlashes(cloudBase);
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return DIRECT_ELIZA_CLOUD_APP_BY_HOST.get(host) ?? normalized;
  } catch {
    // error-policy:J3 malformed configured URLs remain explicit unchanged
    // input; the eventual navigation boundary will reject them.
    return normalized;
  }
}

export function resolveDirectCloudAuthApiBase(cloudBase: string): string {
  const normalized = stripTrailingSlashes(cloudBase);
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return DIRECT_ELIZA_CLOUD_API_BY_HOST.get(host) ?? normalized;
  } catch {
    // error-policy:J3 malformed configured URLs remain explicit unchanged
    // input; the eventual request boundary will reject them.
    return normalized;
  }
}

/**
 * Resolve the fixed API authority used by store-distributed Cloud shells.
 * Unlike the general resolver above, an unknown or malformed configured host
 * is not preserved: store clients must never inherit an owner-selected,
 * sideload, or restored authority.
 */
export function resolveCanonicalDirectCloudApiBase(
  cloudBase: string | null | undefined,
): string {
  const normalized = cloudBase?.trim().replace(/\/+$/, "") ?? "";
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return (
      DIRECT_ELIZA_CLOUD_API_BY_HOST.get(host) ??
      DEFAULT_DIRECT_CLOUD_API_BASE_URL
    );
  } catch {
    return DEFAULT_DIRECT_CLOUD_API_BASE_URL;
  }
}
