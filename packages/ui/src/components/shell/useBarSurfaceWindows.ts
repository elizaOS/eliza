/**
 * Tracks bar-surface window placement so launcher and overlay panes stay
 * within viewport constraints.
 */
import * as React from "react";

import {
  type NavigateViewDetail,
  pathForNavigateViewDetail,
} from "../../app-navigate-view";
import {
  openDesktopAppWindow,
  openDesktopLauncherWindow,
} from "../../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { NAVIGATE_VIEW_EVENT } from "../../events";

/** Detail shape used by views/launcher whose own window should open. */
type OpenWindowFn = typeof openDesktopAppWindow;
type OpenLauncherFn = typeof openDesktopLauncherWindow;

/** View ids that resolve to the launcher/springboard rather than a single view. */
const LAUNCHER_VIEW_IDS: ReadonlySet<string> = new Set([
  "launcher",
  "views",
  "views-manager",
]);

/**
 * Bridge the chromeless bottom-bar shell to on-demand surface windows (#9953
 * Phase 3). The bar renders only the chat overlay — it has no full-app tab
 * system — so a "show a view" / "show the launcher" intent (the
 * `eliza:navigate:view` bus the agent + slash commands already drive) must open
 * a dedicated desktop window instead of switching an inline tab.
 *
 * The launcher is summoned as its own window; it is never the resting surface.
 * No-op off desktop (the bar shell only runs on the Electrobun desktop).
 *
 * The `openWindow` / `openLauncher` deps are injectable for tests.
 */
export function useBarSurfaceWindows(options?: {
  openWindow?: OpenWindowFn;
  openLauncher?: OpenLauncherFn;
  isDesktop?: () => boolean;
}): void {
  const openWindow = options?.openWindow ?? openDesktopAppWindow;
  const openLauncher = options?.openLauncher ?? openDesktopLauncherWindow;
  const isDesktop = options?.isDesktop ?? isElectrobunRuntime;

  const openWindowRef = React.useRef(openWindow);
  openWindowRef.current = openWindow;
  const openLauncherRef = React.useRef(openLauncher);
  openLauncherRef.current = openLauncher;

  React.useEffect(() => {
    if (typeof window === "undefined" || !isDesktop()) return;
    const onNavigate = (event: Event): void => {
      const detail = (event as CustomEvent<NavigateViewDetail>).detail;
      if (!detail || detail.action === "close" || detail.action === "close-all")
        return;
      if (detail.viewId && LAUNCHER_VIEW_IDS.has(detail.viewId)) {
        void openLauncherRef.current();
        return;
      }
      const path = pathForNavigateViewDetail(detail);
      if (!path) return;
      void openWindowRef.current({
        slug: detail.viewId,
        title: detail.viewLabel ?? detail.viewId ?? "View",
        path,
        alwaysOnTop: detail.alwaysOnTop === true,
      });
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
    return () => window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
  }, [isDesktop]);
}
