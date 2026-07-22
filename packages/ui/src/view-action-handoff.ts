/**
 * Converts successful VIEWS action summaries from a completed chat turn into
 * shell navigation. Chat streams exist on every runtime transport, so this is
 * the reliable handoff when a platform intentionally runs without WebSockets.
 */

import { ElizaError } from "@elizaos/core";
import type { ChatActionResultSummary } from "./api/client-types-chat";
import { fetchWithCsrf } from "./api/csrf-client";
import { dispatchNavigateViewEvent } from "./events";
import { getWindowNavigationPath } from "./navigation";

interface CurrentViewNavigation {
  viewId: string;
  viewPath: string | null;
  viewLabel: string;
  viewType: "gui" | "tui" | "xr";
  action?: string;
  views?: string[];
  layout?: string;
  placement?: string;
  subview?: string;
  alwaysOnTop?: boolean;
  source?: "agent" | "user";
}

interface CurrentViewResponse {
  currentView: CurrentViewNavigation | null;
  justSwitched: boolean;
}

export interface ViewActionHandoff {
  viewId: string;
  subview?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function findViewActionHandoff(
  actionResults: readonly ChatActionResultSummary[] | undefined,
): ViewActionHandoff | null {
  if (!Array.isArray(actionResults)) return null;
  for (let index = actionResults.length - 1; index >= 0; index--) {
    const result = actionResults[index];
    if (
      result?.success !== true ||
      result.actionName?.toUpperCase() !== "VIEWS"
    ) {
      continue;
    }
    const mode = readString(result.values?.mode)?.toLowerCase();
    const viewId = readString(result.values?.viewId);
    if ((mode === "show" || mode === "open") && viewId) {
      const subview = readString(result.values?.subview);
      return { viewId, ...(subview ? { subview } : {}) };
    }
  }
  return null;
}

function parseCurrentViewResponse(body: unknown): CurrentViewResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ElizaError("Malformed /api/views/current response", {
      code: "VIEW_HANDOFF_RESPONSE_INVALID",
    });
  }
  const response = body as { currentView?: unknown; justSwitched?: unknown };
  const currentView = response.currentView;
  if (currentView === null) {
    return { currentView: null, justSwitched: response.justSwitched === true };
  }
  if (
    !currentView ||
    typeof currentView !== "object" ||
    Array.isArray(currentView)
  ) {
    throw new ElizaError("The VIEWS action completed without a current view", {
      code: "VIEW_HANDOFF_CURRENT_VIEW_MISSING",
    });
  }
  const record = currentView as Record<string, unknown>;
  const viewId = readString(record.viewId);
  const viewLabel = readString(record.viewLabel);
  const viewType = record.viewType;
  const viewPath = record.viewPath;
  if (
    !viewId ||
    !viewLabel ||
    (viewType !== "gui" && viewType !== "tui" && viewType !== "xr") ||
    !(typeof viewPath === "string" || viewPath === null)
  ) {
    throw new ElizaError("Malformed current view navigation fields", {
      code: "VIEW_HANDOFF_RESPONSE_INVALID",
    });
  }
  return {
    justSwitched: response.justSwitched === true,
    currentView: {
      viewId,
      viewLabel,
      viewType,
      viewPath,
      ...(readString(record.action)
        ? { action: readString(record.action) }
        : {}),
      ...(Array.isArray(record.views)
        ? {
            views: record.views.filter(
              (view): view is string => typeof view === "string",
            ),
          }
        : {}),
      ...(readString(record.layout)
        ? { layout: readString(record.layout) }
        : {}),
      ...(readString(record.placement)
        ? { placement: readString(record.placement) }
        : {}),
      ...(readString(record.subview)
        ? { subview: readString(record.subview) }
        : {}),
      ...(record.alwaysOnTop === true ? { alwaysOnTop: true } : {}),
      ...(record.source === "agent" || record.source === "user"
        ? { source: record.source }
        : {}),
    },
  };
}

async function fetchCurrentViewResponse(
  fetchCurrentView?: () => Promise<Response>,
): Promise<CurrentViewResponse> {
  const response = await (fetchCurrentView?.() ??
    fetchWithCsrf("/api/views/current"));
  if (!response.ok) {
    throw new ElizaError(
      `GET /api/views/current returned HTTP ${response.status}`,
      {
        code: "VIEW_HANDOFF_CURRENT_VIEW_HTTP_FAILED",
        context: { status: response.status },
      },
    );
  }
  return parseCurrentViewResponse(await response.json());
}

export async function dispatchViewActionHandoff(
  actionResults: readonly ChatActionResultSummary[] | undefined,
  dependencies: {
    fetchCurrentView?: () => Promise<Response>;
    dispatch?: typeof dispatchNavigateViewEvent;
    currentPath?: () => string;
  } = {},
): Promise<boolean> {
  const handoff = findViewActionHandoff(actionResults);
  if (!handoff) return false;

  const { currentView: current } = await fetchCurrentViewResponse(
    dependencies.fetchCurrentView,
  );
  if (!current) {
    throw new ElizaError("The VIEWS action completed without a current view", {
      code: "VIEW_HANDOFF_CURRENT_VIEW_MISSING",
    });
  }
  if (current.viewId !== handoff.viewId) {
    throw new ElizaError(
      `VIEWS action selected "${handoff.viewId}" but current view is "${current.viewId}"`,
      {
        code: "VIEW_HANDOFF_VIEW_MISMATCH",
        context: {
          actionViewId: handoff.viewId,
          currentViewId: current.viewId,
        },
      },
    );
  }

  const currentPath = dependencies.currentPath?.() ?? getWindowNavigationPath();
  const targetPath = current.viewPath ?? `/apps/${current.viewId}`;
  // A live WebSocket may already have delivered the same switch while the chat
  // response was streaming. Avoid adding a duplicate browser-history entry;
  // subviews still dispatch because their selected section is not encoded in
  // every platform's URL.
  if (currentPath === targetPath && !current.subview && !handoff.subview) {
    return false;
  }

  const dispatch = dependencies.dispatch ?? dispatchNavigateViewEvent;
  dispatch({
    viewId: current.viewId,
    ...(current.viewPath ? { viewPath: current.viewPath } : {}),
    viewLabel: current.viewLabel,
    viewType: current.viewType,
    ...(current.action ? { action: current.action } : {}),
    ...(current.views ? { views: current.views } : {}),
    ...(current.layout ? { layout: current.layout } : {}),
    ...(current.placement ? { placement: current.placement } : {}),
    ...((current.subview ?? handoff.subview)
      ? { subview: current.subview ?? handoff.subview }
      : {}),
    ...(current.alwaysOnTop ? { alwaysOnTop: true } : {}),
  });
  return true;
}

/** Recover one recent agent navigation that was missed while transport was down. */
export async function recoverMissedCurrentView(
  dependencies: {
    fetchCurrentView?: () => Promise<Response>;
    dispatch?: typeof dispatchNavigateViewEvent;
    currentPath?: () => string;
  } = {},
): Promise<boolean> {
  const readPath = dependencies.currentPath ?? getWindowNavigationPath;
  const pathBeforeFetch = readPath();
  const { currentView: current, justSwitched } = await fetchCurrentViewResponse(
    dependencies.fetchCurrentView,
  );
  if (!current || !justSwitched || current.source !== "agent") return false;

  // Explicit user navigation while the recovery fetch was in flight wins over
  // process-global server state, which may be shared by several windows.
  if (readPath() !== pathBeforeFetch) return false;
  const targetPath = current.viewPath ?? `/apps/${current.viewId}`;
  if (pathBeforeFetch === targetPath && !current.subview) return false;

  const dispatch = dependencies.dispatch ?? dispatchNavigateViewEvent;
  // Recovery replays destination state only. Edge commands such as pin/window
  // or layout actions must never execute again on every resume/reconnect.
  dispatch({
    viewId: current.viewId,
    ...(current.viewPath ? { viewPath: current.viewPath } : {}),
    viewLabel: current.viewLabel,
    viewType: current.viewType,
    ...(current.subview ? { subview: current.subview } : {}),
  });
  return true;
}
