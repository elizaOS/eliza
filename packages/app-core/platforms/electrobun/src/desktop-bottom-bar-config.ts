/**
 * Chromeless bottom-bar desktop shell (#9953).
 *
 * The target desktop product is a minimal, chromeless chat bar pinned to the
 * bottom of the screen rather than a full-window dashboard. This module owns the
 * pure decisions for that shell: whether to launch into it, how to tag the
 * renderer URL so the React app renders the chat-overlay shell only (not the
 * full `<App>`), and the bar's screen geometry.
 *
 * Opt-in (default OFF) via `ELIZA_DESKTOP_BOTTOM_BAR=1`, mirroring the
 * `ELIZA_DESKTOP_TRAY_FIRST` rollout: flipping the default to bottom-bar-first
 * is gated on the per-platform device verification in PR_EVIDENCE.md. Excludes
 * kiosk shell mode (kiosk wants a fullscreen view-manager surface).
 */

import { isKioskShellMode } from "./kiosk-mode";

function parseTruthy(value: string | undefined): boolean {
  if (!value) return false;
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
 * the full-window dashboard. Opt-in via `ELIZA_DESKTOP_BOTTOM_BAR=1`; never in
 * kiosk mode.
 */
export function shouldStartBottomBar(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (!parseTruthy(env.ELIZA_DESKTOP_BOTTOM_BAR)) {
    return false;
  }
  if (isKioskShellMode(env, argv)) {
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
  try {
    const url = new URL(rendererUrl);
    url.searchParams.set("shellMode", "chat-overlay");
    return url.href;
  } catch {
    const separator = rendererUrl.includes("?") ? "&" : "?";
    return `${rendererUrl}${separator}shellMode=chat-overlay`;
  }
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
