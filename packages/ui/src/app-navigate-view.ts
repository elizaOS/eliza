/**
 * Fires the shared navigate-view event to open a registered view, the imperative
 * entry the agent's view actions and the shell use to switch views.
 */
import {
  dispatchNavigateViewEvent,
  type NavigateViewDetail,
} from "@elizaos/shared/events";
import type { ViewRegistryEntry } from "./hooks/useAvailableViews";
import { type Tab, tabFromPath } from "./navigation";

export type { NavigateViewDetail };

export type ActiveViewLayout = {
  mode: "split" | "tile";
  viewIds: string[];
  layout?: string;
  placement?: string;
};

const pendingNavigateViewPayloads = new Map<string, unknown>();

// Cross-view phone-number handoff.
//
// `NavigateViewDetail` (and `createNavigateViewHandler`) route only by view
// id/path — there is no payload channel that reaches a *mounted* target view.
// So when one in-app surface wants to open the Phone or Messages view
// pre-seeded with a number (e.g. a Contacts "Call"/"Message" control, or a
// phone-recent row), we stash the number here before dispatching the navigate
// event, and the target view consumes it on mount/focus. The handoff is
// single-shot: each `consume*` clears the value so a later plain navigation to
// that view does not re-seed a stale number.

/** Strip whitespace/separators, keeping a leading + and digits. */
function normalizePhoneNumber(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const leadingPlus = trimmed.startsWith("+") ? "+" : "";
  return `${leadingPlus}${trimmed.replace(/[^0-9]/g, "")}`;
}

let pendingPhoneNumber: string | null = null;
let pendingMessageRecipient: string | null = null;

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

export function consumePendingPhoneNumber(): string | null {
  const number = pendingPhoneNumber;
  pendingPhoneNumber = null;
  return number;
}

export function consumePendingMessageRecipient(): string | null {
  const address = pendingMessageRecipient;
  pendingMessageRecipient = null;
  return address;
}

/**
 * Open the Phone view via the navigation bus, pre-seeding the dialer with
 * `number`. Used by Contacts "Call" controls and phone-recent rows.
 */
export function navigateToPhoneWithNumber(number: string): void {
  if (typeof window === "undefined") return;
  pendingPhoneNumber = normalizePhoneNumber(number) || null;
  dispatchNavigateViewEvent({ viewId: "phone", viewPath: "/phone" });
}

/**
 * Open the Messages view via the navigation bus, pre-seeding the composer "To"
 * field with `address`. Used by Contacts "Message" controls.
 */
export function navigateToMessagesWithNumber(address: string): void {
  if (typeof window === "undefined") return;
  const trimmed = address.trim();
  pendingMessageRecipient = trimmed || null;
  dispatchNavigateViewEvent({ viewId: "messages", viewPath: "/messages" });
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
  setTab: (tab: Tab) => void;
  setViewLayout?: (layout: ActiveViewLayout | null) => void;
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
      setViewLayout?.({
        mode: detail.action === "split-view" ? "split" : "tile",
        viewIds: resolvedViewIds.length > 0 ? resolvedViewIds : viewIds,
        layout: detail.layout,
        placement: detail.placement,
      });
      setTab("views");
      navigatePath("/views");
      return;
    }
    const path = pathForNavigateViewDetail(detail);
    if (!path) return;
    setViewLayout?.(null);
    const directTab = directTabForNavigateView(detail, path);
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
          if (!result) {
            activateTabForPath(viewPath);
            navigatePath(viewPath);
          }
        })
        .catch(() => {
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
