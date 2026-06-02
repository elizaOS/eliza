import type { ViewRegistryEntry } from "./hooks/useAvailableViews";
import { recordRecentViewId } from "./view-recents";

export type NavigateViewDetail = {
  viewId?: string;
  viewPath?: string;
  viewLabel?: string;
  viewType?: "gui" | "tui" | "xr";
  action?: string;
  alwaysOnTop?: boolean;
};

export type DesktopTabOpen = (
  view: ViewRegistryEntry,
  options?: { pinned?: boolean },
) => void;

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

export function createNavigateViewHandler({
  availableViewsForDesktopTabs,
  invokeDesktopBridgeRequest,
  navigatePath = navigateBrowserPath,
  openDesktopTab,
  setActiveDesktopTabId,
  setTab,
}: {
  availableViewsForDesktopTabs: ViewRegistryEntry[];
  invokeDesktopBridgeRequest: DesktopBridgeRequest;
  navigatePath?: (path: string) => void;
  openDesktopTab: DesktopTabOpen;
  setActiveDesktopTabId: (viewId: string) => void;
  setTab: (tab: "views" | "apps") => void;
}): (event: Event) => void {
  return (event: Event) => {
    const detail = (event as CustomEvent<NavigateViewDetail>).detail;
    if (!detail) return;
    const path = pathForNavigateViewDetail(detail);
    if (!path) return;
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
