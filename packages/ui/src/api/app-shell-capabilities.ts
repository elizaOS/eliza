/**
 * Predicates that classify an API base by which surfaces it exposes — direct
 * Cloud agent bases are chat adapters, so app-shell/orchestrator routes are
 * gated off for them.
 */
import { isDedicatedCloudAgentBase } from "../utils/cloud-agent-base";
import { isDirectCloudSharedAgentBase } from "./client-cloud";

/**
 * Direct Cloud agent bases are chat adapters, not full desktop/app-shell
 * runtimes. They intentionally do not expose routes such as /api/views,
 * /api/apps/runs, /api/workbench/todos, /api/approvals, or orchestrator state.
 */
export function isLimitedCloudAgentApiBase(
  value: string | null | undefined,
): boolean {
  return (
    isDirectCloudSharedAgentBase(value) || isDedicatedCloudAgentBase(value)
  );
}

export function supportsFullAppShellRoutes(
  value: string | null | undefined,
): boolean {
  return !isLimitedCloudAgentApiBase(value);
}

/**
 * Runtime-aware app-shell route gate. The Play Android client has no server at
 * its synthetic Capacitor origin, so an empty authority cannot expose the
 * desktop/local `/api/*` surface even though an empty URL is otherwise valid
 * shorthand for same-origin web deployments.
 */
export function supportsAppShellRoutesForRuntime(
  value: string | null | undefined,
  options: { androidCloudBuild?: boolean } = {},
): boolean {
  if (options.androidCloudBuild && !value?.trim()) return false;
  return supportsFullAppShellRoutes(value);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    // error-policy:J3 untrusted URL string → explicit invalid (null); callers
    // treat null as "not a usable http(s) URL".
    return null;
  }
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isSharedAgentApiResourcePath(pathname: string): boolean {
  return /^\/api\/v1\/eliza\/agents\/[^/]+\/api(?:\/|$)/.test(pathname);
}

export function isLimitedCloudAgentApiResourceUrl(
  value: string | null | undefined,
): boolean {
  if (!value?.trim()) return false;
  const url = parseHttpUrl(value.trim());
  if (!url) return false;
  if (isDedicatedCloudAgentBase(url.origin)) {
    return isApiPath(url.pathname);
  }
  return isSharedAgentApiResourcePath(url.pathname);
}
