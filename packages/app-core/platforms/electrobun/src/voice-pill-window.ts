/**
 * Voice pill window for the onboarding overlay.
 *
 * A small, borderless, transparent, always-on-top BrowserWindow centered at
 * the bottom of the work area. Renders ONLY the OnboardingVoicePill component
 * via `?shellMode=onboarding-voice-pill`.
 *
 * This is a separate native window from the onboarding card so each element
 * occupies only its own footprint — the OS routes clicks outside each window
 * straight to the desktop behind.
 *
 * WHY TWO PILL WINDOWS (voice-pill-window.ts vs pill-window.ts)?
 *   - pill-window.ts — persistent chat-overlay pill; created at app boot via
 *     shouldCreateDesktopPill(); always on top; shellMode=chat-overlay.
 *     This is the live production voice/chat surface the user sees every day.
 *   - voice-pill-window.ts (this file) — ephemeral onboarding-only voice pill;
 *     spawned alongside the onboarding overlay window (onboarding-overlay-window.ts)
 *     only for the duration of first-run; shellMode=onboarding-voice-pill.
 *     Destroyed when onboarding completes; replaced by the persistent pill.
 *
 * Keep both until the onboarding voice UI is fully retired or merged into the
 * persistent pill shell. They exist separately so the onboarding sequence can
 * show a tailored voice prompt without touching the live overlay state machine.
 */

import { type BrowserWindow, Screen } from "electrobun/bun";
import {
  createElectrobunBrowserWindow,
  type ElectrobunBrowserWindowOptions,
} from "./electrobun-window-options";
import { logger } from "./logger";
import { makeKeyAndOrderFront } from "./native/mac-window-effects";

type PillRpc = ElectrobunBrowserWindowOptions["rpc"];

export function buildVoicePillRendererUrl(rendererUrl: string): string {
  const url = new URL(rendererUrl);
  url.search = "?shellMode=onboarding-voice-pill";
  url.hash = "";
  return url.toString();
}

let pillWindow: BrowserWindow | null = null;

const PILL_WIDTH = 200;
const PILL_HEIGHT = 80;

export function createVoicePillWindow(args: {
  rendererUrl: string;
  preload: string;
  rpc?: PillRpc;
}): BrowserWindow {
  if (pillWindow) {
    return pillWindow;
  }

  const workArea = Screen.getPrimaryDisplay().workArea;
  const frame = {
    x: workArea.x + Math.round((workArea.width - PILL_WIDTH) / 2),
    y: workArea.y + workArea.height - PILL_HEIGHT - 32,
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
  };
  const url = buildVoicePillRendererUrl(args.rendererUrl);

  const win = createElectrobunBrowserWindow({
    title: "Eliza Voice",
    url,
    preload: args.preload,
    frame,
    titleBarStyle: "hidden",
    transparent: true,
    activate: false,
    ...(args.rpc ? { rpc: args.rpc } : {}),
  });

  try {
    win.setAlwaysOnTop(true);
  } catch (err) {
    logger.warn(
      `[voice-pill-window] setAlwaysOnTop failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (process.platform === "darwin") {
    win.webview.on("dom-ready", () => {
      const ptr = (win as { ptr?: unknown }).ptr;
      if (ptr) {
        makeKeyAndOrderFront(ptr as Parameters<typeof makeKeyAndOrderFront>[0]);
        logger.info(
          "[voice-pill-window] Activated window via makeKeyAndOrderFront",
        );
      }
    });
  }

  win.on("close", () => {
    pillWindow = null;
  });

  pillWindow = win;
  logger.info(
    `[voice-pill-window] Spawned pill window ${frame.width}x${frame.height} at (${frame.x},${frame.y})`,
  );
  return win;
}

export function getVoicePillWindow(): BrowserWindow | null {
  return pillWindow;
}

export function closeVoicePillWindow(): void {
  if (!pillWindow) return;
  try {
    pillWindow.close();
  } catch (err) {
    logger.warn(
      `[voice-pill-window] close failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  pillWindow = null;
}
