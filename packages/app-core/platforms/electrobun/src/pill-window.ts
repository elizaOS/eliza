/**
 * Pill overlay window for Electrobun.
 *
 * Spawns a single borderless, transparent, always-on-top BrowserWindow
 * docked to the bottom-center of the user's primary display. The window
 * loads the same renderer bundle as the main shell with
 * `?shellMode=chat-overlay`, which routes to the live assistant overlay shell.
 *
 * Lifecycle:
 *  - Created once at app boot, alongside the main window.
 *  - Closing the main window does NOT close the pill, and vice versa.
 *  - Quitting the app closes both (handled by Electrobun's standard
 *    `exitOnLastWindowClosed` behavior firing when both windows are gone,
 *    or by the application's quit menu).
 *
 * WHY TWO PILL WINDOWS (pill-window.ts vs voice-pill-window.ts)?
 *   - pill-window.ts (this file) — persistent chat-overlay pill; created at app
 *     boot when shouldCreateDesktopPill() returns true; shellMode=chat-overlay.
 *     This is the live production voice/chat surface the user sees every day.
 *   - voice-pill-window.ts — ephemeral onboarding-only voice pill; spawned only
 *     for the duration of first-run; shellMode=onboarding-voice-pill. Destroyed
 *     when onboarding completes. This file is NOT used after first-run.
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

export function buildPillRendererUrl(rendererUrl: string): string {
  const url = new URL(rendererUrl);
  url.search = "?shellMode=chat-overlay";
  url.hash = "";
  return url.toString();
}

let pillWindow: BrowserWindow | null = null;

export function createPillWindow(args: {
  rendererUrl: string;
  preload: string;
}): BrowserWindow {
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
    activate: false,
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
  logger.info(
    `[pill-window] Spawned pill overlay at (${frame.x},${frame.y}) ${frame.width}x${frame.height}`,
  );
  return win;
}

export function getPillWindow(): BrowserWindow | null {
  return pillWindow;
}
