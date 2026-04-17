/**
 * GET /api/n8n/status — read-only surface for the Automations tab.
 *
 * Exposes the current n8n mode so the UI can render:
 *   - "Cloud n8n connected"   (cloud auth + cloud.enabled)
 *   - "Local n8n <status>"    (sidecar running / starting / error)
 *   - "Disabled"              (local sidecar disabled + no cloud)
 *
 * Never returns the provisioned API key — secret stays server-side.
 *
 * Context shape matches the other app-core compat routes
 * (cloud-status-routes.ts): `{ req, res, method, pathname, config, runtime,
 * json }`. The sidecar instance is read from the module-level singleton
 * in services/n8n-sidecar.ts rather than being threaded through state,
 * mirroring how steward-sidecar is consumed in develop.
 */

import type { RouteHelpers, RouteRequestMeta } from "@elizaos/agent/api";
import type { AgentRuntime } from "@elizaos/core";
import {
  getN8nSidecar,
  type N8nSidecar,
  type N8nSidecarStatus,
  peekN8nSidecar,
} from "../services/n8n-sidecar";

export type N8nMode = "cloud" | "local" | "disabled";

export interface N8nStatusResponse {
  mode: N8nMode;
  host: string | null;
  status: N8nSidecarStatus;
  cloudConnected: boolean;
  localEnabled: boolean;
}

/**
 * Minimal shape of the relevant config slice. Agent A owns the canonical
 * `N8nConfig` type in the config module; this interface is a narrow
 * read-only view so this route does not take a hard dependency on that
 * work landing first.
 *
 * TODO(agent-a): once `N8nConfig` is exported from the config module,
 * replace this with `Pick<ElizaConfig, "cloud" | "n8n">`.
 */
export interface N8nStatusConfigLike {
  cloud?: {
    enabled?: boolean;
    apiKey?: string;
  };
  n8n?: {
    localEnabled?: boolean;
    host?: string | null;
  };
}

export interface N8nStatusRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json"> {
  config: N8nStatusConfigLike;
  runtime: AgentRuntime | null;
  /**
   * Optional sidecar override. When absent, the handler reads the
   * module-level singleton via `peekN8nSidecar()`. Tests inject a stub.
   */
  n8nSidecar?: N8nSidecar | null;
}

interface CloudAuthLike {
  isAuthenticated: () => boolean;
}

function isCloudConnected(
  config: N8nStatusConfigLike,
  runtime: AgentRuntime | null,
): boolean {
  if (!config.cloud?.enabled) return false;
  const auth = runtime
    ? (runtime.getService("CLOUD_AUTH") as unknown as CloudAuthLike | null)
    : null;
  if (auth?.isAuthenticated?.()) return true;
  // API-key fallback — matches cloud-status-routes semantics.
  return Boolean(config.cloud.apiKey?.trim());
}

export async function handleN8nStatusRoutes(
  ctx: N8nStatusRouteContext,
): Promise<boolean> {
  const { res, method, pathname, config, runtime, json } = ctx;

  // POST /api/n8n/sidecar/start — fire-and-forget sidecar boot.
  // The local sidecar is lazy; this endpoint allows the UI to kick it off
  // without waiting for the first workflow request.
  if (method === "POST" && pathname === "/api/n8n/sidecar/start") {
    const sidecar =
      ctx.n8nSidecar ??
      getN8nSidecar({
        enabled: config.n8n?.localEnabled ?? true,
        ...(config.n8n?.host ? {} : {}),
      });
    // Fire-and-forget; errors are surfaced via subsequent status polls.
    void sidecar.start();
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (method !== "GET" || pathname !== "/api/n8n/status") {
    return false;
  }

  const sidecar =
    ctx.n8nSidecar === undefined ? peekN8nSidecar() : ctx.n8nSidecar;

  const cloudConnected = isCloudConnected(config, runtime);
  const localEnabled = config.n8n?.localEnabled ?? true;
  const sidecarState = sidecar?.getState();
  const status: N8nSidecarStatus = sidecarState?.status ?? "stopped";

  let mode: N8nMode;
  if (cloudConnected) {
    mode = "cloud";
  } else if (localEnabled) {
    mode = "local";
  } else {
    mode = "disabled";
  }

  const host =
    mode === "local" ? (sidecarState?.host ?? config.n8n?.host ?? null) : null;

  const payload: N8nStatusResponse = {
    mode,
    host,
    status,
    cloudConnected,
    localEnabled,
  };

  json(res, payload);
  return true;
}
