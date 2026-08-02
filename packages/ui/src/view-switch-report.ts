/**
 * Keeps the runtime's active-view state aligned with user-controlled browser
 * navigation. Agent navigation already stamps the server before it reaches the
 * shell; this module fills the inverse path after reloads, history traversal,
 * and runtime restarts without overwriting an already-matching agent switch.
 */

import { ElizaError } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { supportsFullAppShellRoutes } from "./api/app-shell-capabilities";
import { getElizaApiBase, getElizaApiToken } from "./utils/eliza-globals";

interface ViewSwitchRequestDependencies {
  apiBase?: string;
  apiToken?: string | null;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

interface CurrentViewIdentity {
  viewId: string;
  viewPath: string | null;
}

function requestContext(deps: ViewSwitchRequestDependencies): {
  base: string;
  fetchFn: typeof fetch;
  headers: Record<string, string>;
} | null {
  const base = deps.apiBase ?? getElizaApiBase();
  if (!base || !supportsFullAppShellRoutes(base)) return null;
  const token = deps.apiToken ?? getElizaApiToken();
  return {
    base,
    fetchFn: deps.fetchFn ?? fetch,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
}

function parseCurrentView(body: unknown): CurrentViewIdentity | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ElizaError("Malformed current-view response", {
      code: "CURRENT_VIEW_SYNC_RESPONSE_INVALID",
    });
  }
  const currentView = (body as { currentView?: unknown }).currentView;
  if (currentView === null) return null;
  if (
    !currentView ||
    typeof currentView !== "object" ||
    Array.isArray(currentView)
  ) {
    throw new ElizaError("Malformed current-view response", {
      code: "CURRENT_VIEW_SYNC_RESPONSE_INVALID",
    });
  }
  const record = currentView as Record<string, unknown>;
  if (
    typeof record.viewId !== "string" ||
    !(typeof record.viewPath === "string" || record.viewPath === null)
  ) {
    throw new ElizaError("Malformed current-view identity", {
      code: "CURRENT_VIEW_SYNC_RESPONSE_INVALID",
    });
  }
  return { viewId: record.viewId, viewPath: record.viewPath };
}

async function postUserViewSwitch(
  viewId: string,
  viewPath: string | undefined,
  deps: ViewSwitchRequestDependencies,
): Promise<boolean> {
  const context = requestContext(deps);
  if (!context) return false;
  const response = await context.fetchFn(
    `${context.base}/api/views/${encodeURIComponent(viewId)}/navigate`,
    {
      method: "POST",
      headers: context.headers,
      body: JSON.stringify({
        source: "user",
        ...(viewPath ? { path: viewPath } : {}),
      }),
      signal: deps.signal,
    },
  );
  if (!response.ok) {
    throw new ElizaError(
      `Current-view report returned HTTP ${response.status}`,
      {
        code: "CURRENT_VIEW_SYNC_REPORT_FAILED",
        context: { status: response.status, viewId },
      },
    );
  }
  return true;
}

/** Report an explicit user navigation without blocking the visible switch. */
export function reportUserViewSwitch(viewId: string, viewPath?: string): void {
  void postUserViewSwitch(viewId, viewPath, {}).catch((error) => {
    // error-policy:J7 the view remains navigable when telemetry is unavailable;
    // the structured warning keeps the failed state convergence observable.
    logger.warn(
      { error, viewId, viewPath },
      "[view-switch-report] user view-switch report failed",
    );
  });
}

/**
 * Converge a visible browser route after reload/history/restart. A matching
 * server identity is left untouched so an agent-authored switch retains its
 * source and acknowledgement semantics.
 */
export async function synchronizeUserViewSwitch(
  viewId: string,
  viewPath: string | undefined,
  deps: ViewSwitchRequestDependencies = {},
): Promise<boolean> {
  const context = requestContext(deps);
  if (!context) return false;
  const response = await context.fetchFn(`${context.base}/api/views/current`, {
    method: "GET",
    headers: context.headers,
    signal: deps.signal,
  });
  if (!response.ok) {
    throw new ElizaError(`Current-view read returned HTTP ${response.status}`, {
      code: "CURRENT_VIEW_SYNC_READ_FAILED",
      context: { status: response.status, viewId },
    });
  }
  const current = parseCurrentView(await response.json());
  if (
    current?.viewId === viewId &&
    (viewPath === undefined || current.viewPath === viewPath)
  ) {
    return false;
  }
  return postUserViewSwitch(viewId, viewPath, deps);
}
