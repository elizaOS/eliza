/**
 * Public URL derivation for container and managed-frontend publication.
 *
 * Container hosts use an id-derived label under the apps data-plane domain;
 * static frontends use the stable project slug under the Worker frontend
 * domain. Both fail closed when their operator-owned suffix is absent so a
 * caller never stamps a plausible-looking URL that the platform cannot serve.
 */

import { containersEnv } from "../config/containers-env";

export interface AppPublicEndpoint {
  /** `<shortid>.<base-domain>` — written to containers.public_hostname. */
  hostname: string;
  /** `https://<hostname>` — written to containers.load_balancer_url + apps.production_url. */
  url: string;
}

/** Derive the app's public endpoint from its container id, or null if unconfigured. */
export function deriveAppPublicUrl(containerId: string): AppPublicEndpoint | null {
  const baseDomain = containersEnv.appsPublicBaseDomain();
  if (!baseDomain) return null;
  // 8 hex chars from the (UUID v4) container id — matches the agent ingress
  // shortid scheme so the wildcard DNS routes the same way.
  const shortId = containerId.replace(/-/g, "").slice(0, 8);
  const hostname = `${shortId}.${baseDomain}`;
  return { hostname, url: `https://${hostname}` };
}

/**
 * Derive the stable system URL for a managed frontend.
 *
 * The slug comes from the Cloud app record and the suffix comes from
 * `ELIZA_FRONTEND_HOST_SUFFIX`. Both are constrained to DNS labels because the
 * URL is also returned to untrusted browser clients and written into
 * `app_url`/`allowed_origins` after an active deployment is confirmed.
 */
export function deriveManagedFrontendPublicUrl(
  slug: string,
  configuredSuffix: string | undefined,
): AppPublicEndpoint | null {
  const normalizedSlug = slug.trim().toLowerCase();
  const normalizedSuffix = configuredSuffix
    ?.trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedSlug) ||
    !normalizedSuffix ||
    !normalizedSuffix.includes(".") ||
    !normalizedSuffix
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return null;
  }
  const hostname = `${normalizedSlug}.${normalizedSuffix}`;
  if (hostname.length > 253) return null;
  return { hostname, url: `https://${hostname}` };
}
