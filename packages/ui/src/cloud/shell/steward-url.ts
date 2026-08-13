/**
 * Browser-side Steward API URL resolution for the app-hosted cloud surfaces.
 *
 * Ported from `@elizaos/cloud-shared/lib/steward-url` (which is not a dependency
 * of `@elizaos/ui`) so the app shell can resolve the Steward mount without
 * pulling the cloud-shared server bundle. The default is the same-origin
 * `/steward` mount; known Eliza hosts bypass the Pages proxy and call
 * the matching API worker directly (the Worker allowlists those origins for
 * CORS + credentials).
 */

import {
  ELIZA_DOMAIN_CONTRACTS,
  LEGACY_ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/shared";
import { configuredStewardApiUrlOverride } from "./steward-config";

const STEWARD_PREFIX = "/steward";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getBrowserOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const origin = window.location?.origin;
  return typeof origin === "string" ? origin : undefined;
}

function getBrowserHostname(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const hostname = window.location?.hostname;
  return typeof hostname === "string" ? hostname.toLowerCase() : undefined;
}

/**
 * Hostnames where the SPA is co-hosted with a Cloudflare Pages deployment that
 * proxies `/steward/*` and `/api/*` to the Workers API. Canonical hosts remain
 * same-origin so Steward cookies are host-only; sharing a parent-domain cookie
 * would expose it to managed-agent and user-content subdomains.
 *
 * Single source of truth for the browser host → API worker map. Every host
 * must map to its OWN env's worker (staging → api-staging, never prod). The
 * Steward auth endpoints (StewardProviderShared, steward-session) resolve off
 * this same map — a host missing here silently downgrades its auth calls to
 * the co-hosted proxy.
 */
function hostname(origin: string): string {
  return new URL(origin).hostname;
}

const production = ELIZA_DOMAIN_CONTRACTS.production;
const staging = ELIZA_DOMAIN_CONTRACTS.staging;

export const ELIZA_CLOUD_DIRECT_API_BY_HOST: Record<string, string> = {
  [hostname(production.marketingOrigin)]: production.marketingOrigin,
  [`www.${hostname(production.marketingOrigin)}`]: production.marketingOrigin,
  [hostname(production.cloudAppOrigin)]: production.cloudAppOrigin,
  [hostname(staging.marketingOrigin)]: staging.marketingOrigin,
  [hostname(staging.cloudAppOrigin)]: staging.cloudAppOrigin,
  ...Object.fromEntries(
    [
      ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.marketingHostnames,
      ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudAppHostnames,
    ].map((host) => [host, `https://${host}`]),
  ),
  ...Object.fromEntries(
    [
      ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.marketingHostnames,
      ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudAppHostnames,
    ].map((host) => [host, `https://${host}`]),
  ),
};

export function resolveBrowserStewardApiUrl(origin?: string): string {
  const override = configuredStewardApiUrlOverride();
  if (override) {
    return trimTrailingSlash(override);
  }

  const browserHost = getBrowserHostname();
  const directApi = browserHost
    ? ELIZA_CLOUD_DIRECT_API_BY_HOST[browserHost]
    : undefined;
  if (directApi) {
    return `${directApi}${STEWARD_PREFIX}`;
  }

  const resolvedOrigin = origin ?? getBrowserOrigin();
  if (resolvedOrigin) {
    return `${trimTrailingSlash(resolvedOrigin)}${STEWARD_PREFIX}`;
  }

  return STEWARD_PREFIX;
}
