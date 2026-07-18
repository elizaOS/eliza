/**
 * Fires the shared navigate-view event to open a registered view, the imperative
 * entry the agent's view actions and the shell use to switch views.
 */
import { logger } from "@elizaos/logger";
import type { NavigateViewDetail } from "@elizaos/shared/events";
import type { ViewRegistryEntry } from "./hooks/useAvailableViews";
import { type Tab, tabFromPath } from "./navigation";
import { shellHistory } from "./surface-realm-channel";

export type { NavigateViewDetail };

export type ActiveViewLayout = {
  mode: "split" | "tile";
  viewIds: string[];
  focusedViewId?: string;
  layout?: string;
  placement?: string;
};

const VIEW_LAYOUT_HISTORY_KEY = "__elizaViewLayout";

function parseHistoryViewLayout(value: unknown): ActiveViewLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.mode !== "split" && record.mode !== "tile") return null;
  if (
    !Array.isArray(record.viewIds) ||
    record.viewIds.length === 0 ||
    !record.viewIds.every(
      (viewId) => typeof viewId === "string" && viewId.trim().length > 0,
    )
  ) {
    return null;
  }
  const viewIds = record.viewIds.map((viewId) => viewId.trim());
  if (new Set(viewIds).size !== viewIds.length) return null;
  const focusedViewId =
    typeof record.focusedViewId === "string" &&
    viewIds.includes(record.focusedViewId.trim())
      ? record.focusedViewId.trim()
      : viewIds[0];
  return {
    mode: record.mode,
    viewIds,
    ...(focusedViewId ? { focusedViewId } : {}),
    ...(typeof record.layout === "string" && record.layout.trim()
      ? { layout: record.layout.trim() }
      : {}),
    ...(typeof record.placement === "string" && record.placement.trim()
      ? { placement: record.placement.trim() }
      : {}),
  };
}

/** Read the split/tile state attached to this tab's current history entry. */
export function readViewLayoutFromHistory(): ActiveViewLayout | null {
  if (typeof window === "undefined") return null;
  const state = window.history.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  return parseHistoryViewLayout(
    (state as Record<string, unknown>)[VIEW_LAYOUT_HISTORY_KEY],
  );
}

/**
 * Persist layout beside the route in browser history. History state is scoped
 * to one tab and survives document reload without coupling independent tabs.
 */
export function writeViewLayoutToHistory(
  layout: ActiveViewLayout | null,
): void {
  if (typeof window === "undefined") return;
  const current =
    window.history.state &&
    typeof window.history.state === "object" &&
    !Array.isArray(window.history.state)
      ? (window.history.state as Record<string, unknown>)
      : {};
  const next = { ...current };
  if (layout) next[VIEW_LAYOUT_HISTORY_KEY] = { ...layout };
  else delete next[VIEW_LAYOUT_HISTORY_KEY];
  shellHistory.replaceState(next, "", window.location.href);
}

// Cross-view navigation payload channel.
//
// `NavigateViewDetail.payload` is an opaque, view-owned deep-link value:
// `createNavigateViewHandler` stashes it here keyed by target `viewId` before
// switching views, and the target view claims it on mount/focus via
// `consumeNavigateViewPayload<T>()`, narrowing the value at that boundary. The
// handoff is single-shot — `consume` deletes the entry so a later plain
// navigation to the same view does not re-seed a stale payload. The channel is
// generic: no view id is special-cased here, and the plugin that owns a view
// ships its own navigate helper that constructs the payload shape it expects.
const pendingNavigateViewPayloads = new Map<string, unknown>();

export function consumeNavigateViewPayload<T = unknown>(
  viewId: string,
): T | null {
  if (!pendingNavigateViewPayloads.has(viewId)) return null;
  const payload = pendingNavigateViewPayloads.get(viewId) as T;
  pendingNavigateViewPayloads.delete(viewId);
  return payload;
}

export function __setNavigateViewPayloadForTests(
  viewId: string,
  payload: unknown,
): void {
  pendingNavigateViewPayloads.set(viewId, payload);
}

function storeNavigateViewPayload(detail: NavigateViewDetail): void {
  if (!detail.viewId || detail.payload === undefined) return;
  pendingNavigateViewPayloads.set(detail.viewId, detail.payload);
}

export type DesktopTabOpen = (
  view: ViewRegistryEntry,
  options?: { pinned?: boolean },
) => void;

export type DesktopTabClose = (viewId: string) => void;

export type DesktopBridgeRequest = <T>(options: {
  rpcMethod: string;
  ipcChannel: string;
  params?: unknown;
}) => Promise<T | null>;

export function pathForNavigateViewDetail(
  detail: NavigateViewDetail,
): string | null {
  return detail.viewPath ?? (detail.viewId ? `/apps/${detail.viewId}` : null);
}

export function directTabForNavigateView(
  detail: NavigateViewDetail,
  path: string,
): "views" | "apps" | null {
  if (path === "/views") return "views";
  if (detail.viewId === "views-manager") {
    return "views";
  }
  return null;
}

export function navigateBrowserPath(path: string): void {
  if (typeof window === "undefined") return;
  try {
    if (window.location.protocol === "file:") {
      window.location.hash = path;
      return;
    }
    shellHistory.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch (err) {
    // error-policy:J4 sandboxed webviews can reject history navigation with a
    // SecurityError; navigation degrades to a no-op there. Logged so silent
    // dead navigation is diagnosable.
    logger.warn({ err, path }, "[app-navigate-view] browser navigation failed");
  }
}

export function desktopEntryForDetail(
  views: ViewRegistryEntry[],
  viewId: string,
): ViewRegistryEntry | undefined {
  return views.find((view) => view.id === viewId);
}

function layoutViewIdsForDetail(detail: NavigateViewDetail): string[] {
  const ids = [
    ...(Array.isArray(detail.views) ? detail.views : []),
    ...(detail.viewId ? [detail.viewId] : []),
  ];
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return [];
    seen.add(trimmed);
    return [trimmed];
  });
}

/**
 * Close one pane from a visible split/tile layout while keeping the remaining
 * panes, route, desktop-tab focus, and history entry in agreement. Both agent
 * navigation and the desktop tab bar use this transition so either close
 * affordance produces the same surviving workspace.
 */
export function closeVisibleViewLayoutPane({
  availableViewsForDesktopTabs,
  closeDesktopTab,
  navigatePath = navigateBrowserPath,
  setActiveDesktopTabId,
  setTab,
  setViewLayout,
  viewId,
  viewLayout,
}: {
  availableViewsForDesktopTabs: ViewRegistryEntry[];
  closeDesktopTab?: DesktopTabClose;
  navigatePath?: (path: string) => void;
  setActiveDesktopTabId: (viewId: string | null) => void;
  setTab: (tab: Tab) => void;
  setViewLayout?: (layout: ActiveViewLayout | null) => void;
  viewId: string;
  viewLayout: ActiveViewLayout | null;
}): boolean {
  if (!viewLayout?.viewIds.includes(viewId)) return false;

  const remainingViewIds = viewLayout.viewIds.filter(
    (layoutViewId) => layoutViewId !== viewId,
  );
  closeDesktopTab?.(viewId);

  if (remainingViewIds.length > 1) {
    const focusedViewId =
      viewLayout.focusedViewId &&
      remainingViewIds.includes(viewLayout.focusedViewId)
        ? viewLayout.focusedViewId
        : remainingViewIds[0];
    const nextLayout: ActiveViewLayout = {
      ...viewLayout,
      viewIds: remainingViewIds,
      focusedViewId,
    };
    setViewLayout?.(nextLayout);
    setActiveDesktopTabId(focusedViewId);
    setTab("views");
    navigatePath("/views");
    writeViewLayoutToHistory(nextLayout);
    return true;
  }

  const remainingViewId = remainingViewIds[0];
  setViewLayout?.(null);
  writeViewLayoutToHistory(null);
  if (remainingViewId) {
    const remainingEntry = desktopEntryForDetail(
      availableViewsForDesktopTabs,
      remainingViewId,
    );
    const remainingPath = remainingEntry?.path ?? `/apps/${remainingViewId}`;
    const routeTab = tabFromPath(remainingPath);
    setActiveDesktopTabId(remainingViewId);
    if (routeTab) setTab(routeTab);
    navigatePath(remainingPath);
  } else {
    setActiveDesktopTabId(null);
    setTab("chat");
  }
  return true;
}

export function createNavigateViewHandler({
  activeForegroundViewId,
  availableViewsForDesktopTabs,
  closeDesktopTab,
  desktopTabs = [],
  invokeDesktopBridgeRequest,
  navigatePath = navigateBrowserPath,
  openDesktopTab,
  setActiveDesktopTabId,
  setTab,
  setViewLayout,
  viewLayout = null,
}: {
  activeForegroundViewId?: string | null;
  availableViewsForDesktopTabs: ViewRegistryEntry[];
  closeDesktopTab?: DesktopTabClose;
  desktopTabs?: Array<{ viewId: string }>;
  invokeDesktopBridgeRequest: DesktopBridgeRequest;
  navigatePath?: (path: string) => void;
  openDesktopTab: DesktopTabOpen;
  setActiveDesktopTabId: (viewId: string | null) => void;
  setTab: (tab: Tab) => void;
  setViewLayout?: (layout: ActiveViewLayout | null) => void;
  viewLayout?: ActiveViewLayout | null;
}): (event: Event) => void {
  const activateTabForPath = (path: string) => {
    const routeTab = tabFromPath(path);
    if (routeTab) setTab(routeTab);
  };

  return (event: Event) => {
    const detail = (event as CustomEvent<NavigateViewDetail>).detail;
    if (!detail) return;
    storeNavigateViewPayload(detail);
    if (detail.action === "close" || detail.action === "close-all") {
      const closesEveryView =
        detail.action === "close-all" || detail.viewId === "__all__";
      const targetedViewIsVisible = detail.viewId
        ? viewLayout
          ? viewLayout.viewIds.includes(detail.viewId)
          : activeForegroundViewId === undefined
            ? undefined
            : activeForegroundViewId === detail.viewId
        : false;
      if (
        !closesEveryView &&
        detail.viewId &&
        targetedViewIsVisible === false
      ) {
        closeDesktopTab?.(detail.viewId);
        return;
      }
      if (
        !closesEveryView &&
        detail.viewId &&
        viewLayout?.viewIds.includes(detail.viewId)
      ) {
        closeVisibleViewLayoutPane({
          availableViewsForDesktopTabs,
          closeDesktopTab,
          navigatePath,
          setActiveDesktopTabId,
          setTab,
          setViewLayout,
          viewId: detail.viewId,
          viewLayout,
        });
        return;
      }
      setViewLayout?.(null);
      writeViewLayoutToHistory(null);
      if (closesEveryView) {
        for (const tab of desktopTabs) {
          closeDesktopTab?.(tab.viewId);
        }
      } else if (detail.viewId) {
        closeDesktopTab?.(detail.viewId);
      }
      setActiveDesktopTabId(null);
      setTab("chat");
      return;
    }
    if (detail.action === "split-view" || detail.action === "tile-views") {
      const viewIds = layoutViewIdsForDetail(detail);
      const resolvedViewIds: string[] = [];
      for (const viewId of viewIds) {
        const entry = desktopEntryForDetail(
          availableViewsForDesktopTabs,
          viewId,
        );
        if (!entry) continue;
        resolvedViewIds.push(entry.id);
        openDesktopTab(entry, { pinned: false });
      }
      const primaryViewId =
        resolvedViewIds[0] ?? viewIds[0] ?? detail.viewId ?? null;
      if (primaryViewId) setActiveDesktopTabId(primaryViewId);
      const nextLayout: ActiveViewLayout = {
        mode: detail.action === "split-view" ? "split" : "tile",
        viewIds: resolvedViewIds.length > 0 ? resolvedViewIds : viewIds,
        ...(primaryViewId ? { focusedViewId: primaryViewId } : {}),
        layout: detail.layout,
        placement: detail.placement,
      };
      setViewLayout?.(nextLayout);
      setTab("views");
      navigatePath("/views");
      writeViewLayoutToHistory(nextLayout);
      return;
    }
    const path = pathForNavigateViewDetail(detail);
    if (!path) return;
    setViewLayout?.(null);
    const directTab = directTabForNavigateView(detail, path);
    if (directTab) {
      writeViewLayoutToHistory(null);
      setTab(directTab);
      return;
    }
    if (detail.action === "open-window" && detail.viewId) {
      const entry = desktopEntryForDetail(
        availableViewsForDesktopTabs,
        detail.viewId,
      );
      const viewPath = entry?.path ?? `/apps/${detail.viewId}`;
      const viewLabel = entry?.label ?? detail.viewId;
      void invokeDesktopBridgeRequest<{ id: string }>({
        rpcMethod: "desktopOpenAppWindow",
        ipcChannel: "desktop:openAppWindow",
        params: {
          title: viewLabel,
          path: viewPath,
          alwaysOnTop: detail.alwaysOnTop === true,
        },
      })
        .then((result) => {
          if (!result) {
            activateTabForPath(viewPath);
            navigatePath(viewPath);
          } else {
            // A separate window leaves this history entry in place, so clear
            // layout metadata here rather than relying on a fresh route entry.
            writeViewLayoutToHistory(null);
          }
        })
        .catch((err: unknown) => {
          // error-policy:J4 designed degrade: when the desktop bridge cannot
          // open a separate window, the view opens as an in-shell tab instead —
          // the user still lands on the view. Logged so a broken bridge is
          // observable.
          logger.warn(
            { err, viewPath },
            "[app-navigate-view] desktop openAppWindow failed; opening in-shell",
          );
          activateTabForPath(viewPath);
          navigatePath(viewPath);
        });
      return;
    }
    if (detail.viewId) {
      const entry = desktopEntryForDetail(
        availableViewsForDesktopTabs,
        detail.viewId,
      );
      if (entry && (detail.action === "pin-tab" || entry.desktopTabEnabled)) {
        openDesktopTab(entry, { pinned: detail.action === "pin-tab" });
        setActiveDesktopTabId(entry.id);
      }
    }
    activateTabForPath(path);
    navigatePath(path);
  };
}
