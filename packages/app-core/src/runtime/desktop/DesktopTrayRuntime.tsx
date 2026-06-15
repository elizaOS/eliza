import {
  getElectrobunRendererRpc,
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "@elizaos/ui/bridge/electrobun-rpc";
import { isElectrobunRuntime } from "@elizaos/ui/bridge/electrobun-runtime";
import { TRAY_ACTION_EVENT } from "@elizaos/ui/events";
import { useApp } from "@elizaos/ui/state/useApp";
import { openDesktopSettingsWindow } from "@elizaos/ui/utils/desktop-workspace";
import { useEffect } from "react";

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
