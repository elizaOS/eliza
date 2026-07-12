/**
 * Predicates and normalization for cloud agent base URLs (dedicated vs shared
 * direct-cloud bases), used to route the client and gate app-shell capabilities.
 */
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

// Staging apex + API. Without these, `staging.elizacloud.ai` ends with
// `.elizacloud.ai` and is misclassified as a per-agent subdomain.
const STAGING_CONSOLE_HOSTS = new Set([
  "staging.elizacloud.ai",
  "api-staging.elizacloud.ai",
  "app-staging.elizacloud.ai",
]);

/**
 * Eliza Cloud control-plane hostnames. The bare origin (and the
 * `/api/v1/eliza/agents` collection) on any of these is NOT a per-agent base —
 * it is the managed cloud endpoint that requires an `/<agentId>` segment before
 * any `/api/*` agent route resolves.
 */
export const ELIZA_CLOUD_CONTROL_PLANE_HOSTS = new Set([
  "api.elizacloud.ai",
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
  "app.elizacloud.ai",
  ...STAGING_CONSOLE_HOSTS,
]);

function isStagingCloudHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    STAGING_CONSOLE_HOSTS.has(host) || host.endsWith(".staging.elizacloud.ai")
  );
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
 * `<agentId>.elizacloud.ai` production ingress or the environment-matched
 * `<agentId>.staging.elizacloud.ai` staging ingress. Returns null when the id
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
  const suffix =
    cloudUrl && isStagingCloudHostname(cloudUrl.hostname)
      ? ".staging.elizacloud.ai"
      : ".elizacloud.ai";
  return `https://${label}${suffix}`;
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
  if (!ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(url.hostname.toLowerCase())) {
    return false;
  }
  return isCloudAgentsCollectionBase(value);
}

/**
 * True when `value` is a DEDICATED cloud agent base — an agent that lives on its
 * own `<agentId>.elizacloud.ai` subdomain (not a control-plane host, not the
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
  return (
    host.endsWith(".elizacloud.ai") &&
    !ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(host)
  );
}

/**
 * Extract the agent id from a dedicated cloud agent base
 * (`https://<agentId>.elizacloud.ai` or its staging equivalent) — the
 * left-most subdomain label. Returns null for any base that is not a dedicated
 * cloud agent subdomain.
 */
export function dedicatedCloudAgentIdFromBase(
  value: string | null | undefined,
): string | null {
  if (!isDedicatedCloudAgentBase(value)) return null;
  const url = normalizeHttpUrl((value as string).trim());
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const suffix = isStagingCloudHostname(host)
    ? ".staging.elizacloud.ai"
    : ".elizacloud.ai";
  const label = host.slice(0, host.length - suffix.length);
  return label.includes(".") ? label.slice(label.lastIndexOf(".") + 1) : label;
}

/** Production Eliza *app* origin — where the agent-app (chat / create-agent)
 * lives. The console (elizacloud.ai / dashboard) is NOT the app; the app is
 * served from `app.elizacloud.ai`. */
export const PROD_ELIZA_APP_ORIGIN = "https://app.elizacloud.ai";
/** Staging Eliza *app* origin. The staging console lives at
 * `staging.elizacloud.ai`; its paired app is `app-staging.elizacloud.ai`
 * (a DIFFERENT tenant/session from prod). */
export const STAGING_ELIZA_APP_ORIGIN = "https://app-staging.elizacloud.ai";

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
  if (host && STAGING_CONSOLE_HOSTS.has(host)) {
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
