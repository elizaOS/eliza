/**
 * Chromeless bottom-bar desktop shell (#9953).
 *
 * The target desktop product is a minimal, chromeless chat bar pinned to the
 * bottom of the screen rather than a full-window dashboard. This module owns the
 * pure decisions for that shell: whether to launch into it, how to tag the
 * renderer URL so the React app renders the chat-overlay shell only (not the
 * full `<App>`), and the bar's screen geometry.
 *
 * Default ON (#10350): the chromeless bottom bar is the resting desktop surface,
 * satisfying #9953 acceptance criterion #1. The opt-out kill switch is
 * `ELIZA_DESKTOP_BOTTOM_BAR=0` (or `false`/`no`/`off`), which restores the legacy
 * full-window dashboard. Excludes kiosk shell mode (kiosk wants a fullscreen
 * view-manager surface), which always wins.
 */

import { appendShellModeParam, isKioskShellMode } from "./kiosk-mode";

/** Explicit opt-out values for the bottom-bar default (the kill switch). */
function parseFalsy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  );
}

/** Explicit opt-in values for experiments that default OFF. */
function parseTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

/**
 * Whether the chat-overlay (bottom-bar) window should install a real
 * NSVisualEffectView behind its transparent WKWebView — the layered-glass
 * architecture: [desktop] → [NSVisualEffectView, BehindWindow blending] →
 * [transparent WKWebView] → [CSS glass in the renderer]. With it on, the
 * renderer's glass surfaces refract the actual desktop instead of compositing
 * over pure transparency.
 *
 * Opt-in via `ELIZA_DESKTOP_NATIVE_GLASS=1` and macOS-only: the effect view is
 * full-window, so it frosts the entire bar frame including the empty region
 * beside the pill (#12184 rejected exactly that look as the default), and the
 * native hook (`enableWindowVibrancy` in libMacWindowEffects.dylib) exists only
 * on darwin. Default OFF preserves the pill-paints-itself presentation.
 */
export function shouldEnableNativeGlass(
  env: Record<string, string | undefined> = process.env,
  platform: typeof process.platform = process.platform,
): boolean {
  return platform === "darwin" && parseTruthy(env.ELIZA_DESKTOP_NATIVE_GLASS);
}

/**
 * Whether the desktop should launch as a chromeless bottom chat bar instead of
 * the full-window dashboard. Default ON (#10350); opt out with
 * `ELIZA_DESKTOP_BOTTOM_BAR=0`; never in kiosk mode.
 */
export function shouldStartBottomBar(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (isKioskShellMode(env, argv)) {
    return false;
  }
  if (parseFalsy(env.ELIZA_DESKTOP_BOTTOM_BAR)) {
    return false;
  }
  return true;
}

/**
 * Append `?shellMode=chat-overlay` to the renderer URL so the React app renders
 * its `ChatOverlayShell` (the bar + assistant overlay only) over a transparent
 * background. Preserves any existing query string and hash routing.
 */
export function appendChatOverlayShellModeParam(rendererUrl: string): string {
  return appendShellModeParam(rendererUrl, "chat-overlay");
}

export interface ScreenWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BottomBarFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopShellWindowMode = "default" | "kiosk" | "bottom-bar";
export type DesktopShellTitleBarStyle = "hidden" | "hiddenInset" | "default";

export interface DesktopShellWindowPresentation {
  mode: DesktopShellWindowMode;
  titleBarStyle: DesktopShellTitleBarStyle;
  transparent: boolean;
}

/**
 * Resolve the window presentation for the current shell mode.
 *
 * Transparency is scoped to the chromeless bottom-bar pill on macOS only. The
 * full dashboard ("default") window and kiosk stay opaque: a transparent window
 * over dark web content reads as a full-window frosted sheet (the pill is the
 * only surface that should show the desktop through it). Win/Linux transparency
 * support varies, so the pill also stays opaque there for now (fork gap G4).
 */
export function resolveDesktopShellWindowPresentation(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
  platform: typeof process.platform = process.platform,
): DesktopShellWindowPresentation {
  const kiosk = isKioskShellMode(env, argv);
  const bottomBar = !kiosk && shouldStartBottomBar(env, argv);
  return {
    mode: kiosk ? "kiosk" : bottomBar ? "bottom-bar" : "default",
    titleBarStyle:
      kiosk || bottomBar
        ? "hidden"
        : platform === "darwin"
          ? "hiddenInset"
          : "default",
    transparent: bottomBar && platform === "darwin",
  };
}

/** Default bar height — tall enough for the glass composer + a few message lines. */
export const DEFAULT_BOTTOM_BAR_HEIGHT = 140;

/**
 * Two window footprints for the floating chat overlay (#16200). The singular
 * ChatOverlay computes its detents (pill → input → half → full → maximized)
 * against its viewport, so the WINDOW must be full-screen whenever the overlay
 * is open for those detents to map correctly. But a full-screen transparent
 * window is opaque to OS hit-testing across its whole frame — it eats every
 * click in the empty region beside the pill, so the user can't click the app
 * underneath. The fix is to shrink the window to the pill's own footprint while
 * it RESTS at the pill (`pill`), and grow it to the full work area the instant
 * the user engages (`open`). Both frames are bottom-pinned to the same edge, so
 * the pill never jumps as the window grows/shrinks. There is no static
 * whole-window passthrough anymore — click-through at rest is simply the
 * absence of a window over the rest of the screen.
 */
export type ChatOverlayWindowTier = "pill" | "open";

/** Resting-pill window footprint (centered bottom). */
export const PILL_WINDOW_WIDTH = 560;
export const PILL_WINDOW_HEIGHT = 140;
/** Gap between the pill window and the work-area bottom edge. */
export const PILL_WINDOW_BOTTOM_MARGIN = 12;

/**
 * Compute the chat-overlay window frame for a display's usable work area at the
 * given tier. `pill` is a small centered window hugging the bottom edge (so the
 * rest of the screen is click-through — there is no window there); `open` is the
 * full usable work area (so the overlay's half/full/maximized detents map to
 * real screen space). Both are bottom-pinned to the same edge.
 */
export function computeChatOverlayWindowFrame(
  workArea: ScreenWorkArea,
  tier: ChatOverlayWindowTier,
): BottomBarFrame {
  const areaX = Math.round(workArea.x);
  const areaY = Math.round(workArea.y);
  const areaW = Math.max(1, Math.round(workArea.width));
  const areaH = Math.max(1, Math.round(workArea.height));
  if (tier === "open") {
    return { x: areaX, y: areaY, width: areaW, height: areaH };
  }
  const width = Math.min(areaW, PILL_WINDOW_WIDTH);
  const height = Math.min(areaH, PILL_WINDOW_HEIGHT);
  const x = areaX + Math.round((areaW - width) / 2);
  const y = areaY + areaH - height - PILL_WINDOW_BOTTOM_MARGIN;
  return { x, y, width, height };
}

/**
 * Compute the bottom-bar window frame for a display's usable work area: full
 * usable width, a fixed bar height, pinned to the bottom edge (above the
 * taskbar/dock, which `workArea` already excludes). An optional side margin
 * insets the bar horizontally. Retained for callers/tests that want the legacy
 * full-width band; the live shell now uses {@link computeChatOverlayWindowFrame}
 * with a tier.
 */
export function computeBottomBarFrame(
  workArea: ScreenWorkArea,
  options?: { height?: number; margin?: number },
): BottomBarFrame {
  const height = Math.max(
    48,
    Math.round(options?.height ?? DEFAULT_BOTTOM_BAR_HEIGHT),
  );
  const margin = Math.max(0, Math.round(options?.margin ?? 0));
  const width = Math.max(1, Math.round(workArea.width) - margin * 2);
  const x = Math.round(workArea.x) + margin;
  const y =
    Math.round(workArea.y) + Math.round(workArea.height) - height - margin;
  return { x, y, width, height };
}

/**
 * Whether the bottom bar must be re-anchored because the primary display's
 * usable work area moved or resized (a display was plugged/unplugged, the dock
 * or menu bar changed size, or the resolution changed). The bar frame is
 * derived entirely from the work area, so any change to it strands the bar off
 * the new bottom edge until we recompute + `setFrame`. Pure so the poll +
 * `showWindow()` re-anchor decision is unit-testable.
 */
export function shouldReanchorBottomBar(
  prevWorkArea: ScreenWorkArea,
  nextWorkArea: ScreenWorkArea,
): boolean {
  return (
    prevWorkArea.x !== nextWorkArea.x ||
    prevWorkArea.y !== nextWorkArea.y ||
    prevWorkArea.width !== nextWorkArea.width ||
    prevWorkArea.height !== nextWorkArea.height
  );
}
