/**
 * Canonicalizes Eliza Cloud web and API endpoints. Browser navigation and API
 * transport deliberately use different hosts, and both production and staging
 * aliases resolve through this single table.
 */

export const DEFAULT_DIRECT_CLOUD_BASE_URL = "https://elizacloud.ai";
export const DEFAULT_DIRECT_CLOUD_API_BASE_URL = "https://api.elizacloud.ai";
export const STAGING_DIRECT_CLOUD_BASE_URL = "https://staging.elizacloud.ai";
export const STAGING_DIRECT_CLOUD_API_BASE_URL =
  "https://api-staging.elizacloud.ai";

export const DIRECT_ELIZA_CLOUD_API_BY_HOST = new Map([
  ["api.elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["www.elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["dev.elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["app.elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["api-staging.elizacloud.ai", STAGING_DIRECT_CLOUD_API_BASE_URL],
  ["staging.elizacloud.ai", STAGING_DIRECT_CLOUD_API_BASE_URL],
  ["app-staging.elizacloud.ai", STAGING_DIRECT_CLOUD_API_BASE_URL],
]);

const DIRECT_ELIZA_CLOUD_WEB_BY_HOST = new Map([
  ["api.elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["www.elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["app.elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["dev.elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["api-staging.elizacloud.ai", STAGING_DIRECT_CLOUD_BASE_URL],
  ["staging.elizacloud.ai", STAGING_DIRECT_CLOUD_BASE_URL],
  ["app-staging.elizacloud.ai", STAGING_DIRECT_CLOUD_BASE_URL],
]);

export function resolveDirectCloudWebBase(cloudBase: string): string {
  const normalized = cloudBase.replace(/\/+$/, "");
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return DIRECT_ELIZA_CLOUD_WEB_BY_HOST.get(host) ?? normalized;
  } catch {
    // error-policy:J3 malformed configured URLs remain explicit unchanged
    // input; the eventual navigation boundary will reject them.
    return normalized;
  }
}

export function resolveDirectCloudAuthApiBase(cloudBase: string): string {
  const normalized = cloudBase.replace(/\/+$/, "");
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return DIRECT_ELIZA_CLOUD_API_BY_HOST.get(host) ?? normalized;
  } catch {
    // error-policy:J3 malformed configured URLs remain explicit unchanged
    // input; the eventual request boundary will reject them.
    return normalized;
  }
}
