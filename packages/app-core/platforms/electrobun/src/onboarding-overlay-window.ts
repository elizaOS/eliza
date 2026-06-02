/**
 * First-run onboarding overlay window for Electrobun.
 *
 * Spawns a single small, borderless, transparent, always-on-top BrowserWindow
 * docked to the top-right of the work area that loads the renderer with
 * `?shellMode=onboarding-overlay` — which renders ONLY the floating onboarding
 * card over a transparent background.
 *
 * The window is sized to the card (not full-screen) so the rest of the desktop
 * stays clickable: a full-screen transparent + passthrough window did not click
 * through reliably on macOS (Electrobun's region-based passthrough relies on
 * WKWebView per-pixel alpha, which is not dependable for dynamic React
 * content), so the empty area captured every click. With a card-sized window
 * the OS routes clicks outside it straight to whatever is behind.
 *
 * This replaces the opaque dashboard window at first launch (opt-in via
 * ELIZA_DESKTOP_ONBOARDING_OVERLAY=1; see shouldStartOnboardingOverlay). Once
 * onboarding completes the overlay is closed and the normal dashboard window
 * opens.
 *
 * Modeled on pill-window.ts (the existing small borderless/transparent overlay).
 */

import { type BrowserWindow, Screen } from "electrobun/bun";
import {
  createElectrobunBrowserWindow,
  type ElectrobunBrowserWindowOptions,
} from "./electrobun-window-options";
import { logger } from "./logger";

/** rpc handle baked into the window at construction (typed via the wrapper). */
type OverlayRpc = ElectrobunBrowserWindowOptions["rpc"];

export function buildOnboardingOverlayRendererUrl(rendererUrl: string): string {
  const url = new URL(rendererUrl);
  url.search = "?shellMode=onboarding-overlay";
  url.hash = "";
  return url.toString();
}

let overlayWindow: BrowserWindow | null = null;

export function createOnboardingOverlayWindow(args: {
  rendererUrl: string;
  preload: string;
  rpc?: OverlayRpc;
}): BrowserWindow {
  if (overlayWindow) {
    return overlayWindow;
  }

  // Size the window to the onboarding card's footprint and dock it top-right of
  // the work area, rather than covering the full screen. A full-screen
  // transparent + passthrough window does NOT reliably click through on macOS:
  // Electrobun's region-based passthrough depends on the WKWebView reporting
  // per-pixel alpha, which it does not do dependably for dynamically-rendered
  // (React) content, so the empty area captured every click and blocked the
  // desktop behind. A small window sidesteps that: the OS routes clicks outside
  // the window straight to whatever is behind it, and only the card's small
  // rect sits on top. (passthrough stays on so the card's transparent margins
  // still fall through where the platform honours it.) The renderer keeps the
  // card pinned top-right within this frame (`items-start justify-end`).
  const CARD_WIDTH = 384;
  // Tall enough for the onboarding card plus the VoicePill stacked below it
  // (App renders <CompactOnboarding showVoicePill />). The card alone is ~180px;
  // the pill adds its own surface beneath.
  const CARD_HEIGHT = 380;
  const workArea = Screen.getPrimaryDisplay().workArea;
  const width = Math.min(CARD_WIDTH, workArea.width);
  const height = Math.min(CARD_HEIGHT, workArea.height);
  const frame = {
    x: workArea.x + Math.max(0, workArea.width - width),
    y: workArea.y,
    width,
    height,
  };
  const url = buildOnboardingOverlayRendererUrl(args.rendererUrl);

  const win = createElectrobunBrowserWindow({
    title: "Eliza Setup",
    url,
    preload: args.preload,
    frame,
    titleBarStyle: "hidden",
    transparent: true,
    passthrough: true,
    ...(args.rpc ? { rpc: args.rpc } : {}),
  });

  try {
    win.setAlwaysOnTop(true);
  } catch (err) {
    logger.warn(
      `[onboarding-overlay] setAlwaysOnTop failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  win.on("close", () => {
    overlayWindow = null;
  });

  overlayWindow = win;
  logger.info(
    `[onboarding-overlay] Spawned transparent click-through overlay ${frame.width}x${frame.height} at (${frame.x},${frame.y})`,
  );
  return win;
}

export function getOnboardingOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}

export function closeOnboardingOverlayWindow(): void {
  if (!overlayWindow) {
    return;
  }
  try {
    overlayWindow.close();
  } catch (err) {
    logger.warn(
      `[onboarding-overlay] close failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  overlayWindow = null;
}
