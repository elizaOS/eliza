/**
 * Cloud site/API URL normalizer. The implementation moved to
 * `@elizaos/shared/elizacloud/base-url` so host-layer packages can normalize
 * URLs without reverse-importing this plugin.
 */
import {
  defaultCloudSiteUrl,
  normalizeCloudSiteUrl,
  resolveCloudRedirectScope,
  resolveCloudApiBaseUrl,
} from "@elizaos/shared";

export {
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
  resolveCloudRedirectScope,
};

function resolveCloudSitePath(rawBaseUrl: string | undefined, path: string): string {
  const siteUrl = normalizeCloudSiteUrl(rawBaseUrl);
  try {
    const parsed = new URL(siteUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${siteUrl.replace(/\/+$/, "")}${path}`;
    }
  } catch {
    // Fall through to the environment-aware canonical site.
  }
  return `${defaultCloudSiteUrl()}${path}`;
}

/** Resolve the account billing page from the same environment as Cloud API traffic. */
export function resolveCloudBillingUrl(rawBaseUrl?: string): string {
  return resolveCloudSitePath(rawBaseUrl, "/cloud/billing");
}

/** Resolve API-key management from the same environment as Cloud API traffic. */
export function resolveCloudApiKeysUrl(rawBaseUrl?: string): string {
  return resolveCloudSitePath(rawBaseUrl, "/cloud/api-keys");
}
