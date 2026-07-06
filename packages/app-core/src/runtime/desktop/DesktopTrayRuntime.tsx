/**
 * Headless desktop runtime (renders null) that binds the Electrobun tray/menu to
 * app actions. Publishes the tray-popover launcher catalog from
 * DESKTOP_VIEW_WINDOWS to the renderer store, subscribes to desktopTrayMenuClick
 * to drive the App-menu "Reset App…" flow, and handles TRAY_ACTION_EVENT items:
 * opening views in their own desktop windows, navigating chat/plugins/
 * notifications, toggling agent lifecycle, firing a test notification, and window
 * show/hide/quit — all through the electrobun-rpc bridge. Only active under
 * isElectrobunRuntime(); polls with backoff until the RPC bridge attaches.
 */
import {
  getElectrobunRendererRpc,
  invokeDesktopBridgeRequest,
  openDesktopAppWindow,
  subscribeDesktopBridgeEvent,
} from "@elizaos/ui/bridge/electrobun-rpc";
import { isElectrobunRuntime } from "@elizaos/ui/bridge/electrobun-runtime";
import {
  dispatchOpenNotificationCenter,
  TRAY_ACTION_EVENT,
} from "@elizaos/ui/events";
import {
  type DesktopLauncherEntry,
  type DesktopLauncherIconId,
  setDesktopLauncherEntries,
} from "@elizaos/ui/state/desktop-tray-launcher";
import { useApp } from "@elizaos/ui/state/useApp";
import { openDesktopSettingsWindow } from "@elizaos/ui/utils/desktop-workspace";
import { useEffect } from "react";
import {
  DESKTOP_VIEW_WINDOWS,
  parseTrayOpenViewItemId,
  trayOpenViewItemId,
} from "./tray-menu";

const LAUNCHER_ICON_IDS: ReadonlySet<string> = new Set<DesktopLauncherIconId>([
  "chat",
  "character",
  "documents",
  "settings",
  "background",
]);

function launcherIconForView(viewId: string): DesktopLauncherIconId {
  return LAUNCHER_ICON_IDS.has(viewId)
    ? (viewId as DesktopLauncherIconId)
    : "view";
}

interface TrayActionDetail {
  itemId?: string;
}

function isAgentActive(state: string | null | undefined): boolean {
  return !(
    state === null ||
    state === undefined ||
    state === "stopped" ||
    state === "not_started"
  );
}

export function DesktopTrayRuntime() {
  const {
    agentStatus,
    handleRestart,
    handleReset,
    handleResetAppliedFromMain,
    handleStart,
    handleStop,
    setTab,
    switchShellView,
    t,
  } = useApp();

  // Publish the tray-popover launcher catalog to the renderer store the popover
  // shell reads (#12184). Single source of truth stays `DESKTOP_VIEW_WINDOWS`;
  // rows dispatch `tray-open-view-*` / `tray-show-window` through the same
  // TRAY_ACTION_EVENT handler wired below, so no new RPC or duplicated catalog.
  useEffect(() => {
    if (!isElectrobunRuntime()) {
      return;
    }
    const viewRows: DesktopLauncherEntry[] = DESKTOP_VIEW_WINDOWS.map(
      (view) => ({
        itemId: trayOpenViewItemId(view.id),
        label: t(view.labelKey, { defaultValue: view.label }),
        icon: launcherIconForView(view.id),
      }),
    );
    setDesktopLauncherEntries([
      {
        itemId: "tray-show-window",
        label: t("desktop.tray.openEliza", { defaultValue: "Open Eliza" }),
        icon: "home",
      },
      ...viewRows,
    ]);
  }, [t]);

  // App menu "Reset App…" reuses the same push channel as tray `navigate-*`.
  // WHY: Electrobun already bridges `desktopTrayMenuClick`; no new IPC type needed.
  // WHY handleReset here: one implementation with Settings (confirm + API + state).
  useEffect(() => {
    if (!isElectrobunRuntime()) {
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let rpcBridgeWaitTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const attach = (): boolean => {
      if (cancelled || !getElectrobunRendererRpc()) {
        return false;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      unsubscribe = subscribeDesktopBridgeEvent({
        rpcMessage: "desktopTrayMenuClick",
        ipcChannel: "desktop:trayMenuClick",
        listener: (payload) => {
          const itemId =
            (payload as { itemId?: string } | null | undefined)?.itemId ?? "";
          if (itemId === "menu-reset-app-applied") {
            void handleResetAppliedFromMain(payload);
            return;
          }
          if (itemId !== "menu-reset-app") {
            return;
          }
          void handleReset();
        },
      });
      return true;
    };

    if (!attach()) {
      // Poll until the RPC bridge is ready. On Windows, PGLite init can
      // take up to 240s so a hard 10s ceiling caused the tray subscription
      // to silently never attach. Back off from 200ms → 2s to stay cheap.
      let pollMs = 200;
      const MAX_POLL_MS = 2_000;
      const schedulePoll = () => {
        if (cancelled) return;
        rpcBridgeWaitTimeoutId = setTimeout(() => {
          rpcBridgeWaitTimeoutId = null;
          if (cancelled) return;
          if (attach()) return; // success — stop polling
          pollMs = Math.min(pollMs * 1.5, MAX_POLL_MS);
          schedulePoll();
        }, pollMs);
      };
      schedulePoll();
    }

    return () => {
      cancelled = true;
      if (rpcBridgeWaitTimeoutId) clearTimeout(rpcBridgeWaitTimeoutId);
      unsubscribe?.();
    };
  }, [handleReset, handleResetAppliedFromMain]);

  useEffect(() => {
    if (!isElectrobunRuntime()) {
      return;
    }

    const handleTrayAction = (event: Event) => {
      const detail = (event as CustomEvent<TrayActionDetail>).detail;
      const itemId = detail?.itemId ?? "";

      const showAndFocusWindow = async () => {
        await invokeDesktopBridgeRequest<void>({
          rpcMethod: "desktopShowWindow",
          ipcChannel: "desktop:showWindow",
        });
        await invokeDesktopBridgeRequest<void>({
          rpcMethod: "desktopFocusWindow",
          ipcChannel: "desktop:focusWindow",
        });
      };

      const run = async () => {
        // "Views" submenu (#10716): open the selected view in its own desktop
        // window via the same app-window path detached surfaces use.
        const viewId = parseTrayOpenViewItemId(itemId);
        if (viewId) {
          const view = DESKTOP_VIEW_WINDOWS.find(
            (entry) => entry.id === viewId,
          );
          if (view) {
            await openDesktopAppWindow({
              slug: `view-${view.id}`,
              title: t(`desktop.views.${view.id}`, {
                defaultValue: view.label,
              }),
              path: view.path,
            });
          }
          return;
        }

        switch (itemId) {
          case "tray-open-chat":
            switchShellView("desktop");
            setTab("chat");
            await showAndFocusWindow();
            return;
          case "tray-open-plugins":
            switchShellView("desktop");
            setTab("plugins");
            await showAndFocusWindow();
            return;
          case "tray-open-notifications":
            // Desktop-native entry (#10706): the notification center is the
            // dashboard widget on the home surface, so the always-mounted
            // headless NotificationsShellBoot answers this event by
            // navigating there.
            switchShellView("desktop");
            dispatchOpenNotificationCenter();
            await showAndFocusWindow();
            return;
          case "tray-open-desktop-workspace":
            await openDesktopSettingsWindow("desktop");
            return;
          case "tray-open-voice-controls":
            await openDesktopSettingsWindow("voice");
            return;
          case "tray-toggle-lifecycle":
            if (isAgentActive(agentStatus?.state)) {
              await handleStop();
            } else {
              await handleStart();
            }
            return;
          case "tray-restart":
            await handleRestart();
            return;
          case "tray-notify":
            await invokeDesktopBridgeRequest<{ id: string }>({
              rpcMethod: "desktopShowNotification",
              ipcChannel: "desktop:showNotification",
              params: {
                title: t("desktop.tray.testNotification.title", {
                  defaultValue: "Desktop",
                }),
                body: t("desktop.tray.testNotification.body", {
                  defaultValue:
                    "Renderer tray actions are wired and responding.",
                }),
                urgency: "normal",
              },
            });
            return;
          case "tray-show-window":
            await showAndFocusWindow();
            return;
          case "tray-hide-window":
            await invokeDesktopBridgeRequest<void>({
              rpcMethod: "desktopHideWindow",
              ipcChannel: "desktop:hideWindow",
            });
            return;
          case "quit":
            await invokeDesktopBridgeRequest<void>({
              rpcMethod: "desktopQuit",
              ipcChannel: "desktop:quit",
            });
            return;
          default:
            return;
        }
      };

      // error-policy:J6 best-effort UI dispatch from a DOM event handler; a
      // failed tray action leaves the window in its current (visible) state,
      // which the user sees and can retry — nothing to unwind here.
      void run().catch(() => {});
    };

    document.addEventListener(TRAY_ACTION_EVENT, handleTrayAction);
    return () => {
      document.removeEventListener(TRAY_ACTION_EVENT, handleTrayAction);
    };
  }, [
    agentStatus?.state,
    handleRestart,
    handleStart,
    handleStop,
    setTab,
    switchShellView,
    t,
  ]);

  return null;
}
