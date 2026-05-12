import { useEffect } from "react";
import {
  getElectrobunRendererRpc,
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { TRAY_ACTION_EVENT } from "../events";
import { useApp } from "../state/useApp";
import type { DesktopClickAuditItem } from "../utils/desktop-workspace";
import { openDesktopSettingsWindow } from "../utils/desktop-workspace";

interface DesktopTrayMenuItem {
  id: string;
  label?: string;
  type?: "normal" | "separator";
}

export const DESKTOP_TRAY_MENU_ITEMS: readonly DesktopTrayMenuItem[] = [
  { id: "tray-open-chat", label: "Open Chat" },
  { id: "tray-open-plugins", label: "Open Plugins" },
  { id: "tray-open-desktop-workspace", label: "Open Desktop Workspace" },
  { id: "tray-open-voice-controls", label: "Open Voice Controls" },
  { id: "tray-sep-0", type: "separator" },
  { id: "tray-toggle-lifecycle", label: "Start/Stop Agent" },
  { id: "tray-restart", label: "Restart Agent" },
  { id: "tray-notify", label: "Send Test Notification" },
  { id: "tray-sep-1", type: "separator" },
  { id: "tray-show-window", label: "Show Window" },
  { id: "tray-hide-window", label: "Hide Window" },
  { id: "tray-sep-2", type: "separator" },
  { id: "quit", label: "Quit" },
] as const;

export const DESKTOP_TRAY_CLICK_AUDIT: readonly DesktopClickAuditItem[] = [
  {
    id: "tray-open-chat",
    entryPoint: "tray",
    label: "Open Chat",
    expectedAction: "Show and focus the main window, then switch to chat.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-open-plugins",
    entryPoint: "tray",
    label: "Open Plugins",
    expectedAction: "Show and focus the main window, then switch to plugins.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-open-desktop-workspace",
    entryPoint: "tray",
    label: "Open Desktop Workspace",
    expectedAction:
      "Open a detached settings window focused on the desktop workspace section.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-open-voice-controls",
    entryPoint: "tray",
    label: "Open Voice Controls",
    expectedAction:
      "Open a detached settings window focused on the voice controls section.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-toggle-lifecycle",
    entryPoint: "tray",
    label: "Start/Stop Agent",
    expectedAction: "Start a stopped agent or stop a running agent.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-restart",
    entryPoint: "tray",
    label: "Restart Agent",
    expectedAction: "Restart the desktop agent runtime.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-notify",
    entryPoint: "tray",
    label: "Send Test Notification",
    expectedAction: "Emit a desktop notification from the renderer.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-show-window",
    entryPoint: "tray",
    label: "Show Window",
    expectedAction: "Show and focus the main desktop window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-hide-window",
    entryPoint: "tray",
    label: "Hide Window",
    expectedAction: "Hide the main desktop window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "quit",
    entryPoint: "tray",
    label: "Quit",
    expectedAction: "Quit the desktop application.",
    runtimeRequirement: "desktop",
    coverage: "manual",
  },
] as const;

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
            console.info(
              "[eliza][reset] menu: main-process reset finished — syncing renderer",
              { itemId },
            );
            void handleResetAppliedFromMain(payload);
            return;
          }
          if (itemId !== "menu-reset-app") {
            return;
          }
          console.info(
            "[eliza][reset] menu: Reset App clicked (legacy IPC — renderer confirm)",
            { itemId },
          );
          void handleReset();
        },
      });
      console.info(
        "[eliza][reset] tray: subscribed to desktopTrayMenuClick (menu Reset App path)",
      );
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
                title: "Desktop",
                body: "Renderer tray actions are wired and responding.",
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
          default:
            return;
        }
      };

      void run().catch((error) => {
        console.warn("[eliza] Desktop tray action failed:", error);
      });
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
  ]);

  return null;
}
