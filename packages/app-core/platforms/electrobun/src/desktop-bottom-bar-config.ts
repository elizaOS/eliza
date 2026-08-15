/**
 * Chromeless bottom-bar desktop shell (#9953).
 *
 * The target desktop product is a minimal, chromeless chat bar pinned to the
 * bottom of the screen rather than a full-window dashboard. This module owns the
 * pure decisions for that shell: whether to launch into it, how to tag the
 * renderer URL so the React app renders the chat-overlay shell only (not the
 * full `<App>`), and the bar's screen geometry.
 *
 * Launch opens the ordinary window; the bar is a summoned surface.
 *
 * This mirrors the assistant this shell is modelled on. Claude Desktop launches
 * into a normal `layer=0` window and exposes its floating quick-chat bar as a
 * SEPARATE, on-demand surface opened from the menu-bar item and dismissed with
 * Escape — the bar never owns the resting state, and its window does not exist
 * while it is closed. Launching straight into a chromeless, transparent,
 * click-through bar instead left the desktop with no reachable window: the bar
 * is nearly invisible at rest, cannot be dragged (no chrome), and its
 * creation-time click-through meant a real cursor could not use it.
 *
 * Opt IN to launching directly into the bar with `ELIZA_DESKTOP_BOTTOM_BAR=1`
 * (or `true`/`yes`/`on`). Kiosk shell mode always wins over both.
 */

import { appendShellModeParam, isKioskShellMode } from "./kiosk-mode";

/** Explicit opt-in values for launching directly into the bottom bar. */
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
 * Whether the desktop should launch as a chromeless bottom chat bar instead of
 * the ordinary window. Default OFF: launch opens the window, and the bar is
 * summoned from the tray. Opt in with `ELIZA_DESKTOP_BOTTOM_BAR=1`; never in
 * kiosk mode.
 */
export function shouldStartBottomBar(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (isKioskShellMode(env, argv)) {
    return false;
  }
  return parseTruthy(env.ELIZA_DESKTOP_BOTTOM_BAR);
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
 * Compute the bottom-bar window frame for a display's usable work area: full
 * usable width, a fixed bar height, pinned to the bottom edge (above the
 * taskbar/dock, which `workArea` already excludes). An optional side margin
 * insets the bar horizontally.
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
