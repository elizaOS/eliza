/**
 * Predicates and normalization for cloud agent base URLs (dedicated vs shared
 * direct-cloud bases), used to route the client and gate app-shell capabilities.
 */
import {
  buildElizaDedicatedAgentOrigin,
  classifyElizaHostname,
  ELIZA_DOMAIN_CONTRACTS,
  isElizaCloudControlPlaneHostname,
  isElizaDedicatedAgentHostname,
  LEGACY_ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/shared";

function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function normalizeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    // error-policy:J3 malformed URL input yields the explicit null signal.
    return null;
  }
}

function directSharedAgentPath(pathname: string): {
  apiPath: string;
  hasBridgeSuffix: boolean;
} | null {
  const path = stripTrailingSlash(pathname);
  const match = /^\/api\/v1\/eliza\/agents\/[^/]+(\/bridge)?$/.exec(path);
  if (!match) return null;
  const hasBridgeSuffix = Boolean(match[1]);
  return {
    apiPath: hasBridgeSuffix ? path.slice(0, -"/bridge".length) : path,
    hasBridgeSuffix,
  };
}

/**
 * Shared-runtime Cloud agents expose REST at
 * `/api/v1/eliza/agents/:id` and JSON-RPC at the sibling `/bridge`.
 */
export function normalizeDirectCloudSharedAgentApiBase(value: string): string {
  const trimmed = stripTrailingSlash(value.trim());
  if (!trimmed) return trimmed;
  const url = normalizeHttpUrl(trimmed);
  if (!url) return trimmed;
  const sharedPath = directSharedAgentPath(url.pathname);
  if (!sharedPath) return trimmed;
  url.pathname = sharedPath.apiPath;
  url.search = "";
  url.hash = "";
  return stripTrailingSlash(url.toString());
}

/**
 * Extract the agent id from a direct shared-runtime Cloud agent base. Shared
 * agents expose exactly one REST conversation and its id is the agent id, so
 * callers can use this to avoid a redundant `/api/conversations` create round
 * trip when the selected base is already scoped to that agent.
 */
export function directCloudSharedAgentIdFromBase(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) return null;
  const url = normalizeHttpUrl(value.trim());
  if (!url) return null;
  const sharedPath = directSharedAgentPath(url.pathname);
  if (!sharedPath) return null;
  const path = stripTrailingSlash(sharedPath.apiPath);
  const agentId = path.slice("/api/v1/eliza/agents/".length);
  try {
    return agentId ? decodeURIComponent(agentId) : null;
  } catch {
    // error-policy:J3 malformed URL encoding yields the explicit null signal.
    return null;
  }
}

/** Account-native Shared ids are stable identities, not sandbox row UUIDs. */
export function isPersonalSharedElizaId(value: string): boolean {
  return /^personal:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * True only for shared-runtime adapter paths on a trusted Eliza Cloud
 * control-plane host. Path-only classification is intentionally broader for
 * protocol routing, but account-session ownership must not capture a
 * self-hosted server that happens to expose the same path shape.
 */
export function isManagedCloudSharedAgentBase(
  value: string | null | undefined,
): boolean {
  if (directCloudSharedAgentIdFromBase(value) === null || !value) return false;
  const url = normalizeHttpUrl(value.trim());
  return Boolean(url && isElizaCloudControlPlaneHostname(url.hostname));
}

function hostnameOf(origin: string): string {
  return new URL(origin).hostname;
}

/**
 * Eliza Cloud control-plane hostnames. The bare origin (and the
 * `/api/v1/eliza/agents` collection) on any of these is NOT a per-agent base —
 * it is the managed cloud endpoint that requires an `/<agentId>` segment before
 * any `/api/*` agent route resolves.
 */
export const ELIZA_CLOUD_CONTROL_PLANE_HOSTS = new Set([
  hostnameOf(ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin),
  `www.${hostnameOf(ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin)}`,
  hostnameOf(ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin),
  hostnameOf(ELIZA_DOMAIN_CONTRACTS.production.cloudApiOrigin),
  hostnameOf(ELIZA_DOMAIN_CONTRACTS.staging.marketingOrigin),
  hostnameOf(ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin),
  hostnameOf(ELIZA_DOMAIN_CONTRACTS.staging.cloudApiOrigin),
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.marketingHostnames,
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudAppHostnames,
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudApiHostnames,
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.marketingHostnames,
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudAppHostnames,
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudApiHostnames,
]);

export function isStagingCloudHostname(hostname: string): boolean {
  return classifyElizaHostname(hostname).environment === "staging";
}

const PROD_CLOUD_ENVIRONMENT_BASE =
  ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin;
const STAGING_CLOUD_ENVIRONMENT_BASE =
  ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin;

/**
 * Choose the Cloud environment origin used when rebuilding a dedicated-agent
 * ingress. Prefer the live page host and an already-staging persisted base
 * over boot config: agent-subdomain bundles ship with the production default
 * `cloudApiBase`, so trusting boot alone rewrote
 * `*.cloud-staging.eliza.app` → `*.cloud.eliza.app` and CORS-wedged boot (#16163
 * follow-up).
 */
export function resolveCloudEnvironmentBase(options: {
  pageHostname?: string | null;
  apiBase?: string | null;
  bootCloudApiBase?: string | null;
  fallback?: string;
}): string {
  const pageHost = options.pageHostname?.trim().toLowerCase() ?? "";
  if (pageHost && isStagingCloudHostname(pageHost)) {
    return STAGING_CLOUD_ENVIRONMENT_BASE;
  }
  if (
    pageHost &&
    classifyElizaHostname(pageHost).environment === "production"
  ) {
    return PROD_CLOUD_ENVIRONMENT_BASE;
  }

  const activeUrl = options.apiBase
    ? normalizeHttpUrl(options.apiBase.trim())
    : null;
  if (activeUrl && isStagingCloudHostname(activeUrl.hostname)) {
    return STAGING_CLOUD_ENVIRONMENT_BASE;
  }

  const boot = options.bootCloudApiBase?.trim() ?? "";
  const bootUrl = boot ? normalizeHttpUrl(boot) : null;
  if (bootUrl && isStagingCloudHostname(bootUrl.hostname)) {
    return STAGING_CLOUD_ENVIRONMENT_BASE;
  }
  if (bootUrl) {
    return stripTrailingSlash(bootUrl.toString());
  }

  return options.fallback?.trim() || PROD_CLOUD_ENVIRONMENT_BASE;
}

/**
 * Build the shared-runtime REST adapter base for a known agent id:
 * `<cloudApiBase>/api/v1/eliza/agents/<agentId>`. This is the base where a
 * Tier-0 shared agent serves its `/api/*` chat surface (verified against live
 * cloud). `cloudApiBase` must already be the resolved direct-cloud origin.
 */
export function buildCloudSharedAgentApiBase(
  cloudApiBase: string,
  agentId: string,
): string {
  const base = stripTrailingSlash(cloudApiBase.trim());
  return `${base}/api/v1/eliza/agents/${encodeURIComponent(agentId.trim())}`;
}

/**
 * Build the dedicated Cloud agent REST base for the standard
 * `<agentId>.cloud.eliza.app` production ingress or the environment-matched
 * `<agentId>.cloud-staging.eliza.app` staging ingress. Returns null when the id
 * cannot be a single DNS label; callers should then fall back to a
 * server-reported URL instead of producing a malformed host.
 */
export function buildDedicatedCloudAgentApiBase(
  agentId: string | null | undefined,
  cloudApiBase?: string | null,
): string | null {
  const label = agentId?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    return null;
  }
  const cloudUrl = cloudApiBase ? normalizeHttpUrl(cloudApiBase.trim()) : null;
  const environment =
    cloudUrl && isStagingCloudHostname(cloudUrl.hostname)
      ? "staging"
      : "production";
  return buildElizaDedicatedAgentOrigin(label, environment);
}

/**
 * True when `value` is an agent-id-LESS cloud base — either an empty/blank value,
 * a bare origin, or the `/api/v1/eliza/agents` collection (no `/<agentId>`).
 * Such a base is unusable for chat: every `/api/*` call concatenates to
 * `.../eliza/agents/api/...` and 404s. Host-agnostic (path-only) so callers can
 * combine it with their own host check.
 */
export function isCloudAgentsCollectionBase(
  value: string | null | undefined,
): boolean {
  if (!value?.trim()) return true;
  const url = normalizeHttpUrl(value.trim());
  if (!url) return false;
  const path = stripTrailingSlash(url.pathname);
  return path === "" || path === "/api/v1/eliza/agents";
}

/**
 * True when `value` points at an Eliza Cloud control-plane host with NO agent id
 * selected (bare origin or the agents collection). This is the "signed in but no
 * agent chosen yet" state — startup should route to agent selection, not a hard
 * "Backend Unreachable".
 */
export function isElizaCloudControlPlaneAgentlessBase(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  const url = normalizeHttpUrl(value.trim());
  if (!url) return false;
  if (!isElizaCloudControlPlaneHostname(url.hostname)) {
    return false;
  }
  return isCloudAgentsCollectionBase(value);
}

const DEVELOP_ELIZA_APP_PAGES_ORIGIN = "https://develop.eliza-app.pages.dev";

/**
 * True when an agentless browser host is trusted to own hosted Cloud
 * onboarding. Canonical and legacy control-plane origins are always trusted.
 * The deployed Cloudflare Pages staging alias is trusted only for an
 * authoritative Cloud-only build and only on its exact HTTPS origin.
 * Other Pages project/preview hosts and self-hosted `cloudOnly` branding must
 * never suppress the local-install/auth gates because they are outside the
 * credentialed API's server-authoritative origin set.
 */
export function isTrustedHostedCloudOnboardingBase(
  value: string | null | undefined,
  cloudOnlyBranding: boolean,
): boolean {
  if (isElizaCloudControlPlaneAgentlessBase(value)) return true;
  if (!cloudOnlyBranding || !value?.trim()) return false;

  const url = normalizeHttpUrl(value.trim());
  if (url?.protocol !== "https:" || !isCloudAgentsCollectionBase(value)) {
    return false;
  }

  return url.origin.toLowerCase() === DEVELOP_ELIZA_APP_PAGES_ORIGIN;
}

/**
 * True when `value` is a DEDICATED cloud agent base — an agent that lives on its
 * own `<agentId>.cloud.eliza.app` subdomain (not a control-plane host, not the
 * shared REST adapter path). Such a base serves chat over REST and 404s on the
 * first-run shell like the shared adapter, but unlike the shared adapter it can
 * also vanish entirely when the agent is deleted or its node is unreachable.
 */
export function isDedicatedCloudAgentBase(
  value: string | null | undefined,
): boolean {
  if (!value?.trim()) return false;
  const url = normalizeHttpUrl(value.trim());
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (isElizaDedicatedAgentHostname(host)) return true;
  const path = stripTrailingSlash(url.pathname);
  const match =
    /^\/api\/v1\/eliza\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/api)?$/i.exec(
      path,
    );
  if (!match) return false;
  return (
    isElizaCloudControlPlaneHostname(host) ||
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1"
  );
}

/**
 * Extract the agent id from a dedicated cloud agent base
 * (`https://<agentId>.cloud.eliza.app` or its staging equivalent) — the
 * left-most subdomain label. Returns null for any base that is not a dedicated
 * cloud agent subdomain.
 */
export function dedicatedCloudAgentIdFromBase(
  value: string | null | undefined,
): string | null {
  if (!isDedicatedCloudAgentBase(value)) return null;
  const url = normalizeHttpUrl((value as string).trim());
  if (!url) return null;
  const classified = classifyElizaHostname(url.hostname).agentId;
  if (classified) return classified;
  const match = /^\/api\/v1\/eliza\/agents\/([0-9a-f-]+)(?:\/api)?\/?$/i.exec(
    url.pathname,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

/** Production managed Eliza origin, where the agent app and Cloud management
 * routes are consolidated under `cloud.eliza.app`. */
export const PROD_ELIZA_APP_ORIGIN =
  ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin;
/** Staging managed Eliza origin. Its paired public site is `staging.eliza.app`;
 * `cloud-staging.eliza.app` uses a different tenant/session from production. */
export const STAGING_ELIZA_APP_ORIGIN =
  ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin;

/**
 * Resolve the Eliza *app* origin (the create-agent / "Open Eliza app" target)
 * for the CURRENT console host. The console dashboard has no create-agent flow
 * of its own and links out to the app; that link must stay within the SAME
 * environment or a signed-in staging user bounces to the PROD app (different
 * tenant, different session — #15161).
 *
 * Fail-safe: a staging console host resolves to the staging app; every other
 * host (prod apex/api, per-agent subdomains, localhost, unknown) resolves to
 * the prod app origin — the historical default, so prod + local behavior is
 * unchanged and only staging is corrected.
 */
export function resolveElizaAppOrigin(
  hostname: string | null | undefined,
): string {
  const host = hostname?.trim().toLowerCase();
  if (host && classifyElizaHostname(host).environment === "staging") {
    return STAGING_ELIZA_APP_ORIGIN;
  }
  return PROD_ELIZA_APP_ORIGIN;
}

/**
 * Browser-safe wrapper: resolve the Eliza app origin from the live
 * `window.location.hostname`. Falls back to the prod app origin when there is
 * no DOM (SSR / tests without a window).
 */
export function currentElizaAppOrigin(): string {
  if (typeof window === "undefined") return PROD_ELIZA_APP_ORIGIN;
  return resolveElizaAppOrigin(window.location.hostname);
}
