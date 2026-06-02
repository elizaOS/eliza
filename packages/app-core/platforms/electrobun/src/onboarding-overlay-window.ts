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
import { makeKeyAndOrderFront } from "./native/mac-window-effects";

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

  // Use the full work area so the renderer can place UI elements anywhere on
  // screen — the onboarding card is pinned top-right via CSS, and the voice
  // pill is centered at the bottom. The window is transparent + passthrough,
  // so clicks on empty regions fall through to the desktop. The
  // makeKeyAndOrderFront call after dom-ready ensures the interactive elements
  // (buttons, pill) receive clicks.
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
    // Match the pill window's proven-visible config. A small, borderless,
    // transparent window only showed reliably with activate:false — a
    // borderless NSWindow cannot become key, and activate:true left the small
    // window unshown (the full-screen variant happened to paint regardless).
    // No passthrough: the window is small, so clicks outside it already reach
    // the desktop via the OS; full-screen-style per-pixel passthrough never
    // composited dependably and is unnecessary here.
    activate: false,
    ...(args.rpc ? { rpc: args.rpc } : {}),
  });

  try {
    win.setAlwaysOnTop(true);
  } catch (err) {
    logger.warn(
      `[onboarding-overlay] setAlwaysOnTop failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The window was created with `activate: false` so it actually renders (a
  // borderless transparent NSWindow does not show reliably with activate:true).
  // But a non-activated window swallows the first click as macOS window
  // activation, making the "Use Local" / "Eliza Cloud" buttons unresponsive.
  //
  // Fix: once the DOM is ready (WKWebView has painted), call the native
  // `makeKeyAndOrderFront` FFI to make the window key. This is the same
  // pattern the main window uses (see desktop.ts showMainWindow).
  if (process.platform === "darwin") {
    win.webview.on("dom-ready", () => {
      const ptr = (win as { ptr?: unknown }).ptr;
      if (ptr) {
        makeKeyAndOrderFront(ptr as Parameters<typeof makeKeyAndOrderFront>[0]);
        logger.info(
          "[onboarding-overlay] Activated window via makeKeyAndOrderFront",
        );
      }
    });
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
