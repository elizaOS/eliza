/**
 * Headless desktop runtime (renders null) that routes Electrobun tray/menu clicks
 * into main-shell navigation. Subscribes to the desktopTrayMenuClick bridge event
 * and, for "show-main:" / "navigate-" item ids in the allowed tab sets, switches
 * to the desktop shell view and sets the active tab; the "open-notifications" item
 * opens the notification center in place instead of navigating a tab.
 */
import { subscribeDesktopBridgeEvent } from "@elizaos/ui/bridge/electrobun-rpc";
import { dispatchOpenNotificationCenter } from "@elizaos/ui/events";
import { useApp } from "@elizaos/ui/state/useApp";
import { useEffect } from "react";
import type { Tab } from "../../../../ui/src/navigation";

const MAIN_SURFACE_TABS = new Set<Tab>(["chat", "plugins", "triggers"]);
const MAIN_NAVIGATION_TABS = new Set<Tab>([
  "chat",
  "plugins",
  "triggers",
  "settings",
]);

export function DesktopSurfaceNavigationRuntime() {
  const { setTab, switchShellView } = useApp();

  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "desktopTrayMenuClick",
      ipcChannel: "desktop:trayMenuClick",
      listener: (payload) => {
        const itemId =
          (payload as { itemId?: string } | null | undefined)?.itemId ?? "";
        // The desktop-native "Notifications" menu/tray item (#10706): open the
        // notification center in place instead of navigating a tab — the
        // visible native way in where the floating bell is hidden.
        if (itemId === "open-notifications") {
          switchShellView("desktop");
          dispatchOpenNotificationCenter();
          return;
        }
        let target: Tab | null = null;
        if (itemId.startsWith("show-main:")) {
          const candidate = itemId.slice("show-main:".length) as Tab;
          if (MAIN_SURFACE_TABS.has(candidate)) {
            target = candidate;
          }
        } else if (itemId.startsWith("navigate-")) {
          const candidate = itemId.slice("navigate-".length) as Tab;
          if (MAIN_NAVIGATION_TABS.has(candidate)) {
            target = candidate;
          }
        }

        if (!target) {
          return;
        }

        switchShellView("desktop");
        setTab(target);
      },
    });
  }, [setTab, switchShellView]);

  return null;
}
