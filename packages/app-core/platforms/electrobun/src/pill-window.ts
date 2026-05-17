/**
 * Pill overlay window for Electrobun.
 *
 * Spawns a single borderless, transparent, always-on-top BrowserWindow
 * docked to the bottom-center of the user's primary display. The window
 * loads the same renderer bundle as the main shell with `?shell=pill`,
 * which `apps/app/src/main.tsx` routes to a minimal `<VoicePill>` mount.
 *
 * Lifecycle:
 *  - Created once at app boot, alongside the main window.
 *  - Closing the main window does NOT close the pill, and vice versa.
 *  - Quitting the app closes both (handled by Electrobun's standard
 *    `exitOnLastWindowClosed` behavior firing when both windows are gone,
 *    or by the application's quit menu).
 *
 * Visibility toggling:
 *  Electrobun's BrowserWindow surface (v1.18) exposes `minimize()`,
 *  `unminimize()`, `isMinimized()`, `focus()`, and `show()` (which is an
 *  alias for `focusWindow`). There is no native `hide()`. We treat
 *  `minimize()` as our hide primitive because it removes the pill from the
 *  active layer without destroying it. `togglePillWindow()` flips between
 *  minimized and visible+focused, recreating the window if it was closed.
 */

import { type BrowserWindow, Screen } from "electrobun/bun";
import { createElectrobunBrowserWindow } from "./electrobun-window-options";
import { logger } from "./logger";

const PILL_WIDTH = 360;
const PILL_HEIGHT = 280;
const PILL_BOTTOM_MARGIN = 16;

interface PillWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PillWindowSpawnArgs {
  rendererUrl: string;
  preload: string;
}

function resolvePillFrame(): PillWindowFrame {
  const display = Screen.getPrimaryDisplay();
  const workArea = display.workArea;
  return {
    x: workArea.x + Math.round((workArea.width - PILL_WIDTH) / 2),
    y: workArea.y + workArea.height - PILL_HEIGHT - PILL_BOTTOM_MARGIN,
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
  };
}

function buildPillRendererUrl(rendererUrl: string): string {
  const url = new URL(rendererUrl);
  url.search = "?shell=pill";
  url.hash = "";
  return url.toString();
}

let pillWindow: BrowserWindow | null = null;
let lastSpawnArgs: PillWindowSpawnArgs | null = null;

export function createPillWindow(args: PillWindowSpawnArgs): BrowserWindow {
  if (pillWindow) {
    return pillWindow;
  }

  const frame = resolvePillFrame();
  const url = buildPillRendererUrl(args.rendererUrl);

  const win = createElectrobunBrowserWindow({
    title: "Eliza Pill",
    url,
    preload: args.preload,
    frame,
    titleBarStyle: "hidden",
    transparent: true,
  });

  try {
    win.setAlwaysOnTop(true);
  } catch (err) {
    logger.warn(
      `[pill-window] setAlwaysOnTop failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  win.on("close", () => {
    pillWindow = null;
  });

  pillWindow = win;
  lastSpawnArgs = args;
  logger.info(
    `[pill-window] Spawned pill overlay at (${frame.x},${frame.y}) ${frame.width}x${frame.height}`,
  );
  return win;
}

export function getPillWindow(): BrowserWindow | null {
  return pillWindow;
}

/**
 * Whether the pill window currently looks visible to the user. False if the
 * window was never created, was closed, or is minimized. Note: Electrobun
 * does not expose a true `isVisible()` check, so this is a best-effort
 * derivation from the live window handle plus `isMinimized()`.
 */
export function isPillWindowVisible(): boolean {
  if (!pillWindow) return false;
  try {
    return !pillWindow.isMinimized();
  } catch (err) {
    logger.warn(
      `[pill-window] isMinimized check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Hide the pill window by minimizing it. Electrobun's BrowserWindow does
 * not expose a native `hide()`, so `minimize()` is the closest approximation
 * that keeps the window alive for fast re-show. No-op if the pill window is
 * not currently spawned.
 */
export function hidePillWindow(): void {
  if (!pillWindow) return;
  try {
    pillWindow.minimize();
  } catch (err) {
    logger.warn(
      `[pill-window] minimize failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Show + focus the pill window. If the window was closed (handle cleared),
 * recreate it using the last spawn args. Returns the live BrowserWindow
 * handle, or `null` if no spawn args have been recorded yet (i.e. the pill
 * was never created in this process).
 */
export function showPillWindow(): BrowserWindow | null {
  if (!pillWindow) {
    if (!lastSpawnArgs) {
      logger.warn(
        "[pill-window] showPillWindow called before pill window was ever spawned",
      );
      return null;
    }
    return createPillWindow(lastSpawnArgs);
  }

  try {
    if (pillWindow.isMinimized()) {
      pillWindow.unminimize();
    }
  } catch (err) {
    logger.warn(
      `[pill-window] unminimize failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    pillWindow.focus();
  } catch (err) {
    logger.warn(
      `[pill-window] focus failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return pillWindow;
}

/**
 * Flip pill visibility: hide if visible, show + focus if hidden/destroyed.
 * Returns the resulting visibility state for the caller to log/telemeter.
 */
export function togglePillWindow(): { visible: boolean } {
  if (isPillWindowVisible()) {
    hidePillWindow();
    return { visible: false };
  }
  showPillWindow();
  return { visible: true };
}
