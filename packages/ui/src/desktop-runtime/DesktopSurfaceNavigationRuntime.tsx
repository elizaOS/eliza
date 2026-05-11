import { useEffect } from "react";
import { subscribeDesktopBridgeEvent } from "../bridge/electrobun-rpc";
import type { Tab } from "../navigation";
import { useApp } from "../state/useApp";

const MAIN_SURFACE_TABS = new Set<Tab>(["chat", "plugins", "triggers"]);
const MAIN_NAVIGATION_TABS = new Set<Tab>([
  "chat",
  "plugins",
  "triggers",
  "lifeops",
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
