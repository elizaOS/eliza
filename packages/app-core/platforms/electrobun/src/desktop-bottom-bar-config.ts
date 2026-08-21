/**
 * Chromeless bottom-bar desktop shell (#9953).
 *
 * The macOS assistant product opens as a minimal chromeless chat bar pinned to
 * the bottom of the screen. The cross-platform Workspace experience and legacy
 * flags can explicitly override that default. This module owns the shell's
 * launch decision, renderer route, and screen geometry. Kiosk mode always wins.
 */

import { isMacosAssistantExperience } from "./desktop-experience-config";
import { appendShellModeParam, isKioskShellMode } from "./kiosk-mode";

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
 * Whether this desktop runtime should launch as a chromeless bottom chat bar
 * instead of the normal full-window Workspace.
 */
export function shouldStartBottomBar(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (isKioskShellMode(env, argv)) {
    return false;
  }
  if (env.ELIZA_DESKTOP_BOTTOM_BAR !== undefined) {
    return parseTruthy(env.ELIZA_DESKTOP_BOTTOM_BAR);
  }
  return isMacosAssistantExperience(env, platform);
}

/**
 * Append `?shellMode=chat-overlay` to the renderer URL so the React app renders
 * its `ChatOverlayShell` (the bar + assistant overlay only) over a transparent
 * background. Preserves any existing query string and hash routing.
 */
export function appendChatOverlayShellModeParam(
  rendererUrl: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const tagged = appendShellModeParam(rendererUrl, "chat-overlay");
  if (env.ELIZAOS_ALWAYS_ON_VOICE !== "1") return tagged;
  try {
    const url = new URL(tagged);
    url.searchParams.set("elizaOSAlwaysOnVoice", "1");
    return url.toString();
  } catch {
    const separator = tagged.includes("?") ? "&" : "?";
    return `${tagged}${separator}elizaOSAlwaysOnVoice=1`;
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

/** Bottom-center point retained when the user repositions the detached host. */
export interface BottomBarAnchor {
  centerX: number;
  bottomY: number;
}

export type BottomBarSurfaceState =
  | "CLOSED"
  | "INPUT"
  | "INPUT_MENU"
  | "OPEN_UNDER_HALF"
  | "OPEN_HALF_OR_OVER"
  | "MAXIMIZED";

export function isBottomBarSurfaceState(
  value: unknown,
): value is BottomBarSurfaceState {
  return (
    value === "CLOSED" ||
    value === "INPUT" ||
    value === "INPUT_MENU" ||
    value === "OPEN_UNDER_HALF" ||
    value === "OPEN_HALF_OR_OVER" ||
    value === "MAXIMIZED"
  );
}

export type DesktopShellWindowMode = "default" | "kiosk" | "bottom-bar";
export type DesktopShellTitleBarStyle = "hidden" | "hiddenInset" | "default";

export interface DesktopShellWindowPresentation {
  mode: DesktopShellWindowMode;
  titleBarStyle: DesktopShellTitleBarStyle;
  transparent: boolean;
  nativeShadow: boolean;
  /** Whether macOS should install native titlebar drag and edge-resize views. */
  nativeChromeInteractive: boolean;
}

/**
 * Resolve the window presentation for the current shell mode.
 *
 * Transparency is scoped to the chromeless bottom-bar shell on every desktop
 * platform. Its renderer paints only the resting pill or shared web chat panel,
 * so the native host must not expose an opaque rectangle around those surfaces.
 * The full dashboard ("default") window and kiosk stay opaque. The transparent
 * pill disables the native window shadow because its visible handle already
 * paints a neutral separator; stacking both creates a heavy halo on light
 * desktops.
 */
export function resolveDesktopShellWindowPresentation(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
  platform: typeof process.platform = process.platform,
): DesktopShellWindowPresentation {
  const kiosk = isKioskShellMode(env, argv);
  const bottomBar = !kiosk && shouldStartBottomBar(env, argv, platform);
  return {
    mode: kiosk ? "kiosk" : bottomBar ? "bottom-bar" : "default",
    titleBarStyle:
      kiosk || bottomBar
        ? "hidden"
        : platform === "darwin"
          ? "hiddenInset"
          : "default",
    transparent: bottomBar,
    nativeShadow: !kiosk && !bottomBar,
    nativeChromeInteractive: !bottomBar,
  };
}

/** Resting native hit area matching the 48×6 visible bar exactly. */
export const DEFAULT_BOTTOM_BAR_WIDTH = 48;
export const DEFAULT_BOTTOM_BAR_HEIGHT = 6;
/**
 * Keep the six-point resting bar visibly above the display edge. The native
 * window remains exactly 48×6, so this does not add any transparent hit area.
 */
export const BOTTOM_BAR_BOTTOM_INSET = 14;

/** Hit area around the cloud-only "Sign in with Eliza Cloud" action. */
export const AUTH_GATE_BOTTOM_BAR_WIDTH = 336;
export const AUTH_GATE_BOTTOM_BAR_HEIGHT = 72;

/** Shallow host for the resting pill's composer preview while hovered. */
export const HOVER_BOTTOM_BAR_WIDTH = 600;
export const HOVER_BOTTOM_BAR_HEIGHT = 64;

/** Input-width host tall enough for the portaled composer actions menu. */
export const INPUT_MENU_BOTTOM_BAR_HEIGHT = 320;

/** Expanded native hit area around the 560×640 glass panel and bottom pill. */
export const EXPANDED_BOTTOM_BAR_WIDTH = 600;
export const EXPANDED_BOTTOM_BAR_HEIGHT = 820;

/** Match ChatOverlay's settled inset radius without making clear corners hot. */
export const BOTTOM_BAR_MATERIAL_CORNER_RADIUS = 32;

export interface BottomBarSizeOptions {
  expanded: boolean;
  /** Labeled needs-auth chip. Ignored while the overlay is expanded. */
  chip?: boolean;
  /** Resting composer preview. Ignored by expanded and auth-gated states. */
  hovered?: boolean;
}

export interface BottomBarMaterialSize {
  width: number;
  height: number;
}

/** Validate renderer-measured material geometry at the native boundary. */
export function normalizeBottomBarMaterialSize(
  size: BottomBarMaterialSize,
): BottomBarMaterialSize {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new RangeError(
      "[desktop-bottom-bar] material size must be positive and finite",
    );
  }
  return {
    width: Math.max(1, Math.round(size.width)),
    height: Math.max(1, Math.round(size.height)),
  };
}

/** Round only the painted capsule/panel; transparent corner pixels pass through. */
export function resolveBottomBarMaterialCornerRadius(
  size: BottomBarMaterialSize,
): number {
  const normalized = normalizeBottomBarMaterialSize(size);
  return Math.min(
    BOTTOM_BAR_MATERIAL_CORNER_RADIUS,
    normalized.width / 2,
    normalized.height / 2,
  );
}

/** Resolve the native bottom-bar size for rest, hover, sign-in, or overlay. */
export function resolveBottomBarFrameSize(options: BottomBarSizeOptions): {
  width: number;
  height: number;
} {
  if (options.expanded) {
    return {
      width: EXPANDED_BOTTOM_BAR_WIDTH,
      height: EXPANDED_BOTTOM_BAR_HEIGHT,
    };
  }
  if (options.chip) {
    return {
      width: AUTH_GATE_BOTTOM_BAR_WIDTH,
      height: AUTH_GATE_BOTTOM_BAR_HEIGHT,
    };
  }
  if (options.hovered) {
    return {
      width: HOVER_BOTTOM_BAR_WIDTH,
      height: HOVER_BOTTOM_BAR_HEIGHT,
    };
  }
  return {
    width: DEFAULT_BOTTOM_BAR_WIDTH,
    height: DEFAULT_BOTTOM_BAR_HEIGHT,
  };
}

/**
 * Compute a bottom-centered window frame that is no larger than the visible
 * pill or expanded chat surface. Keeping the transparent native window narrow
 * prevents its invisible pixels from stealing pointer and keyboard input from
 * other applications.
 */
export function computeBottomBarFrame(
  workArea: ScreenWorkArea,
  options?: { width?: number; height?: number; margin?: number },
): BottomBarFrame {
  const margin = Math.max(0, Math.round(options?.margin ?? 0));
  const availableHeight = Math.max(1, Math.round(workArea.height) - margin);
  const requestedHeight = Math.max(
    1,
    Math.round(options?.height ?? DEFAULT_BOTTOM_BAR_HEIGHT),
  );
  const height = Math.min(requestedHeight, availableHeight);
  const availableWidth = Math.max(1, Math.round(workArea.width) - margin * 2);
  const requestedWidth = Math.max(
    1,
    Math.round(options?.width ?? DEFAULT_BOTTOM_BAR_WIDTH),
  );
  const width = Math.min(requestedWidth, availableWidth);
  const x =
    Math.round(workArea.x) + margin + Math.round((availableWidth - width) / 2);
  const y =
    Math.round(workArea.y) +
    Math.round(workArea.height) -
    height -
    margin -
    BOTTOM_BAR_BOTTOM_INSET;
  return { x, y, width, height };
}

/**
 * Resize a detached surface around its user-selected bottom-center anchor.
 * The result is clamped to the active work area so a display change cannot
 * strand the pill offscreen.
 */
export function anchorBottomBarFrame(
  workArea: ScreenWorkArea,
  frame: BottomBarFrame,
  anchor: BottomBarAnchor,
): BottomBarFrame {
  const minX = Math.round(workArea.x);
  const minY = Math.round(workArea.y);
  const maxX = Math.max(
    minX,
    Math.round(workArea.x + workArea.width - frame.width),
  );
  const maxY = Math.max(
    minY,
    Math.round(workArea.y + workArea.height - frame.height),
  );
  return {
    ...frame,
    x: Math.min(
      maxX,
      Math.max(minX, Math.round(anchor.centerX - frame.width / 2)),
    ),
    y: Math.min(
      maxY,
      Math.max(minY, Math.round(anchor.bottomY - frame.height)),
    ),
  };
}

/**
 * Map the canonical mobile chat state onto a native desktop window. The
 * resting pill keeps only its compact native hit area; an open thread
 * becomes a phone-width sheet anchored above the taskbar; MAXIMIZED owns the
 * complete usable work area so the mobile drag-to-fullscreen contract is not
 * clipped by the native host window.
 */
export function computeBottomBarSurfaceFrame(
  workArea: ScreenWorkArea,
  state: BottomBarSurfaceState,
): BottomBarFrame {
  if (state === "CLOSED") {
    return computeBottomBarFrame(workArea);
  }
  if (state === "INPUT") {
    return computeBottomBarFrame(workArea, {
      width: HOVER_BOTTOM_BAR_WIDTH,
      height: HOVER_BOTTOM_BAR_HEIGHT,
    });
  }
  if (state === "INPUT_MENU") {
    return computeBottomBarFrame(workArea, {
      width: HOVER_BOTTOM_BAR_WIDTH,
      height: INPUT_MENU_BOTTOM_BAR_HEIGHT,
    });
  }
  if (state === "MAXIMIZED") {
    return {
      x: Math.round(workArea.x),
      y: Math.round(workArea.y),
      width: Math.max(1, Math.round(workArea.width)),
      height: Math.max(1, Math.round(workArea.height)),
    };
  }
  const width = Math.min(Math.max(1, Math.round(workArea.width)), 640);
  const heightRatio = state === "OPEN_UNDER_HALF" ? 0.42 : 0.62;
  const minimumHeight = state === "OPEN_UNDER_HALF" ? 320 : 420;
  const height = Math.min(
    Math.max(minimumHeight, Math.round(workArea.height * heightRatio)),
    Math.max(1, Math.round(workArea.height)),
  );
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(
      workArea.y + workArea.height - height - BOTTOM_BAR_BOTTOM_INSET,
    ),
    width,
    height,
  };
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
