/**
 * HTTP routes for the cloud-routed ElevenLabs voice catalog.
 *
 * Exposes a single read-only endpoint:
 *
 *   GET /api/cloud/voices  → { voices: CloudVoiceCatalogEntry[] }
 *
 * The handler always returns `200 OK`. When Eliza Cloud is not connected
 * (no API key, `ELIZAOS_CLOUD_ENABLED` falsy) the response carries an
 * empty `voices` array rather than 5xx-ing — callers (the dashboard
 * voice picker, the agent's voice settings sheet) treat the empty list
 * as "no cloud voices available" and surface a connect-cloud hint if
 * appropriate.
 *
 * The catalog itself is cached for 1 hour in memory by the
 * plugin-elizacloud module; this route is a thin authenticated proxy.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import type { CloudVoiceCatalogEntry } from "@elizaos/plugin-elizacloud";
import {
  ensureRouteAuthorized as defaultEnsureRouteAuthorized,
} from "./auth.ts";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

const ROUTE_PATH = "/api/cloud/voices";

export interface CloudVoiceRouteDeps {
  /**
   * Catalog fetcher; defaults to the production
   * `@elizaos/plugin-elizacloud:fetchCloudVoiceCatalog`. Tests inject a
   * deterministic implementation instead of mocking modules.
   */
  fetchCatalog?: (runtime: AgentRuntime) => Promise<CloudVoiceCatalogEntry[]>;
  /**
   * Auth gate; defaults to `ensureRouteAuthorized` from
   * `./auth`. Tests pass a fake to drive 401 / pass cases.
   */
  ensureAuthorized?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    state: CompatRuntimeState,
  ) => Promise<boolean>;
}

/**
 * Returns `true` when this handler dispatched the request. Returns
 * `false` to let the rest of the route chain run.
 *
 * Auth: callers must be authorized as for any `/api/cloud/*` read; the
 * underlying voice catalog will refuse to reach upstream when cloud is
 * not connected, so leaking the empty-array case is fine — it does not
 * imply a valid cloud session.
 */
export async function handleCloudVoiceRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  deps: CloudVoiceRouteDeps = {},
): Promise<boolean> {
  const fetchCatalog =
    deps.fetchCatalog ??
    (async (rt: AgentRuntime) => {
      const { fetchCloudVoiceCatalog } = await import("@elizaos/plugin-elizacloud");
      return fetchCloudVoiceCatalog(rt);
    });
  const ensureAuthorized = deps.ensureAuthorized ?? defaultEnsureRouteAuthorized;

  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== ROUTE_PATH) return false;

  if (method !== "GET") {
    sendJsonErrorResponse(res, 405, "Method Not Allowed");
    return true;
  }

  if (!(await ensureAuthorized(req, res, state))) return true;

  const runtime = state.current;
  if (!runtime) {
    // Runtime not booted yet → no cloud-connected check is possible. Treat
    // as "no voices available" instead of 503 so the UI can render its
    // empty-state hint without an alarming error toast.
    const empty: CloudVoiceCatalogEntry[] = [];
    sendJsonResponse(res, 200, { voices: empty });
    return true;
  }

  try {
    const voices = await fetchCatalog(runtime);
    sendJsonResponse(res, 200, { voices });
  } catch {
    // The catalog already swallows per-endpoint failures and returns an
    // empty list, but defend against any future change that lets an
    // exception escape.
    const empty: CloudVoiceCatalogEntry[] = [];
    sendJsonResponse(res, 200, { voices: empty });
  }
  return true;
}
