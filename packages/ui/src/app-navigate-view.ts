import type { ViewRegistryEntry } from "./hooks/useAvailableViews";
import { recordRecentViewId } from "./view-recents";

export type NavigateViewDetail = {
  viewId?: string;
  viewPath?: string;
  viewLabel?: string;
  viewType?: "gui" | "tui" | "xr";
  action?: string;
  views?: string[];
  layout?: string;
  placement?: string;
  alwaysOnTop?: boolean;
};

export type ActiveViewLayout = {
  mode: "split" | "tile";
  viewIds: string[];
  layout?: string;
  placement?: string;
};

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
  if (path === "/apps") return "apps";
  if (detail.viewId === "views-manager" && detail.viewType !== "tui") {
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
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch {
    return;
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

export function createNavigateViewHandler({
  availableViewsForDesktopTabs,
  closeDesktopTab,
  desktopTabs = [],
  invokeDesktopBridgeRequest,
  navigatePath = navigateBrowserPath,
  openDesktopTab,
  setActiveDesktopTabId,
  setTab,
  setViewLayout,
}: {
  availableViewsForDesktopTabs: ViewRegistryEntry[];
  closeDesktopTab?: DesktopTabClose;
  desktopTabs?: Array<{ viewId: string }>;
  invokeDesktopBridgeRequest: DesktopBridgeRequest;
  navigatePath?: (path: string) => void;
  openDesktopTab: DesktopTabOpen;
  setActiveDesktopTabId: (viewId: string | null) => void;
  setTab: (tab: "views" | "apps" | "chat") => void;
  setViewLayout?: (layout: ActiveViewLayout | null) => void;
}): (event: Event) => void {
  return (event: Event) => {
    const detail = (event as CustomEvent<NavigateViewDetail>).detail;
    if (!detail) return;
    if (detail.action === "close" || detail.action === "close-all") {
      setViewLayout?.(null);
      if (detail.action === "close-all" || detail.viewId === "__all__") {
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
      let primaryPath: string | null = detail.viewPath ?? null;
      for (const viewId of viewIds) {
        const entry = desktopEntryForDetail(
          availableViewsForDesktopTabs,
          viewId,
        );
        if (!entry) continue;
        resolvedViewIds.push(entry.id);
        recordRecentViewId(entry.id);
        openDesktopTab(entry, { pinned: false });
        primaryPath ??= entry.path ?? `/apps/${entry.id}`;
      }
      const primaryViewId = viewIds[0] ?? detail.viewId ?? null;
      if (primaryViewId) setActiveDesktopTabId(primaryViewId);
      setViewLayout?.({
        mode: detail.action === "split-view" ? "split" : "tile",
        viewIds: resolvedViewIds.length > 0 ? resolvedViewIds : viewIds,
        layout: detail.layout,
        placement: detail.placement,
      });
      setTab("views");
      if (primaryPath) navigatePath(primaryPath);
      return;
    }
    const path = pathForNavigateViewDetail(detail);
    if (!path) return;
    setViewLayout?.(null);
    const directTab = directTabForNavigateView(detail, path);
    if (detail.viewId) {
      recordRecentViewId(detail.viewId);
    }
    if (directTab) {
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
          if (!result) navigatePath(viewPath);
        })
        .catch(() => {
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
    navigatePath(path);
  };
}
