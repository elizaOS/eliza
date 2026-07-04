/**
 * Hook backing the DesktopWorkspaceSection window controls: show/hide/focus,
 * minimize/maximize toggles, and a test notification. Each action goes through
 * the desktop bridge (`invokeDesktopBridgeRequest`, Electrobun RPC + IPC
 * fallback); the minimize/maximize toggles read the current window state from
 * the passed snapshot to pick the RPC method.
 */

import { useMemo } from "react";
import { invokeDesktopBridgeRequest } from "../../bridge";
import type { TranslateFn } from "../../types";
import type { DesktopWorkspaceSnapshot } from "../../utils/desktop-workspace";

export interface DesktopWindowControls {
  show: () => Promise<void>;
  hide: () => Promise<void>;
  focus: () => Promise<void>;
  toggleMinimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  notify: () => Promise<void>;
}

export function useDesktopWindowControls(
  snapshot: DesktopWorkspaceSnapshot | null,
  t: TranslateFn,
): DesktopWindowControls {
  return useMemo<DesktopWindowControls>(
    () => ({
      show: async () => {
        await invokeDesktopBridgeRequest<void>({
          rpcMethod: "desktopShowWindow",
          ipcChannel: "desktop:showWindow",
        });
      },
      hide: async () => {
        await invokeDesktopBridgeRequest<void>({
          rpcMethod: "desktopHideWindow",
          ipcChannel: "desktop:hideWindow",
        });
      },
      focus: async () => {
        await invokeDesktopBridgeRequest<void>({
          rpcMethod: "desktopFocusWindow",
          ipcChannel: "desktop:focusWindow",
        });
      },
      toggleMinimize: async () => {
        const method = snapshot?.window.minimized
          ? "desktopUnminimizeWindow"
          : "desktopMinimizeWindow";
        const channel = snapshot?.window.minimized
          ? "desktop:unminimizeWindow"
          : "desktop:minimizeWindow";
        await invokeDesktopBridgeRequest<void>({
          rpcMethod: method,
          ipcChannel: channel,
        });
      },
      toggleMaximize: async () => {
        const method = snapshot?.window.maximized
          ? "desktopUnmaximizeWindow"
          : "desktopMaximizeWindow";
        const channel = snapshot?.window.maximized
          ? "desktop:unmaximizeWindow"
          : "desktop:maximizeWindow";
        await invokeDesktopBridgeRequest<void>({
          rpcMethod: method,
          ipcChannel: channel,
        });
      },
      notify: async () => {
        await invokeDesktopBridgeRequest<{ id: string }>({
          rpcMethod: "desktopShowNotification",
          ipcChannel: "desktop:showNotification",
          params: {
            title: t("common.desktop"),
            body: t("desktopworkspacesection.NotificationBody"),
            urgency: "normal",
          },
        });
      },
    }),
    [snapshot?.window.minimized, snapshot?.window.maximized, t],
  );
}
