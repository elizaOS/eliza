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

export function isDirectCloudSharedAgentApiBase(value: string): boolean {
  const normalized = normalizeDirectCloudSharedAgentApiBase(value);
  const url = normalizeHttpUrl(normalized);
  if (!url) return false;
  const sharedPath = directSharedAgentPath(url.pathname);
  return Boolean(sharedPath && !sharedPath.hasBridgeSuffix);
}

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
]);

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
