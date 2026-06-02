/**
 * First-run onboarding overlay window for Electrobun.
 *
 * Spawns a single full-screen, borderless, transparent, always-on-top,
 * click-through BrowserWindow that loads the renderer with
 * `?shellMode=onboarding-overlay` — which renders ONLY the floating onboarding
 * card over a transparent background. Electrobun's `passthrough` is
 * region-based: mouse events fall through the transparent (empty) pixels to
 * the desktop behind, while the painted card stays interactive.
 *
 * This replaces the opaque dashboard window at first launch (opt-in via
 * ELIZA_DESKTOP_ONBOARDING_OVERLAY=1; see shouldStartOnboardingOverlay). Once
 * onboarding completes the overlay is closed and the normal dashboard window
 * opens.
 *
 * Modeled on pill-window.ts (the existing borderless/transparent overlay), with
 * the frame expanded to the full work area and `passthrough` enabled.
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

  const workArea = Screen.getPrimaryDisplay().workArea;
  const frame = {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
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
