/** Implements Electrobun desktop desktop tray config ts behavior for app-core shell integration. */
import { isKioskShellMode } from "./kiosk-mode";

function parseTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseFalsy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}

export function shouldCreateDesktopTray(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (parseTruthy(env.ELIZA_DESKTOP_DISABLE_TRAY)) {
    return false;
  }

  if (parseFalsy(env.ELIZA_DESKTOP_TRAY)) {
    return false;
  }

  return true;
}

/**
 * Whether the app should launch dockless (tray-first): the pill + menu-bar
 * icon are the resting surface and the macOS Dock icon stays hidden until a
 * full window (dashboard / surface / settings / app) opens. The pill window is
 * still created at boot — it just doesn't count for the Dock (#12184).
 *
 * Default ON for macOS (#12184), the platform where the Dock/accessory model
 * and menu-bar tray make this the native, unobtrusive experience. Kept
 * macOS-only — on Windows (CEF) the UI message loop must be running before
 * setApplicationMenu(), and Linux tray support varies. Requires the tray to be
 * enabled and excludes kiosk shell mode (kiosk wants a fullscreen window). Kill
 * switch: ELIZA_DESKTOP_TRAY_FIRST=0 restores the Dock icon at rest.
 */
export function shouldStartTrayFirst(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv,
): boolean {
  if (platform !== "darwin") {
    return false;
  }
  if (parseFalsy(env.ELIZA_DESKTOP_TRAY_FIRST)) {
    return false;
  }
  if (!shouldCreateDesktopTray(env)) {
    return false;
  }
  if (isKioskShellMode(env, argv)) {
    return false;
  }
  return true;
}

/**
 * Platforms where the tray popover (a BrowserView attached to a frameless,
 * transparent, always-on-top window anchored at the tray) is implemented today.
 *
 * Scoped honestly per #9953 Phase 4: macOS first, where the transparent +
 * always-on-top BrowserView popover primitive is proven (the same primitive the
 * release-notes window uses). Windows (CEF message-loop ordering) and Linux
 * (tray-geometry support varies by DE) are tracked follow-ups; on those the tray
 * keeps its text context menu.
 */
export const TRAY_POPOVER_SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> =
  new Set<NodeJS.Platform>(["darwin"]);

/**
 * Whether the tray should attach a native context menu.
 *
 * On macOS a set `NSStatusItem.menu` takes over BOTH left and right click:
 * AppKit opens the menu and the status-item button action never fires, so the
 * `tray-clicked` event (and with it click-to-chat) is unreachable. The
 * production macOS behavior is therefore NO attached menu: the icon click
 * toggles the chat window directly. Legacy menu behavior can be restored with
 * ELIZA_DESKTOP_TRAY_MENU=1. Windows/Linux keep their context menus (their
 * native tray implementations deliver icon clicks independently of the menu).
 */
export function shouldAttachTrayMenu(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "darwin") {
    return true;
  }
  return parseTruthy(env.ELIZA_DESKTOP_TRAY_MENU);
}

export type TrayClickAction = "toggle-popover" | "hide-window" | "show-window";

/**
 * Decide what a tray icon click does. Mirrors the chat-overlay summon hotkey
 * semantics (#12184): a configured popover always wins; otherwise a focused,
 * visible window is dismissed and anything else is summoned + focused, so a
 * tray click always has a visible effect.
 */
export function resolveTrayClickAction(state: {
  popoverConfigured: boolean;
  windowVisible: boolean;
  windowFocused: boolean;
}): TrayClickAction {
  if (state.popoverConfigured) {
    return "toggle-popover";
  }
  if (state.windowVisible && state.windowFocused) {
    return "hide-window";
  }
  return "show-window";
}

/**
 * Whether a tray click should open the widget popover instead of (just) showing
 * the main window. Default ON on macOS: the popover launcher is the menu-bar
 * views surface (its rows mirror the curated launcher list, published by
 * DesktopTrayRuntime), and its first row — "Open Eliza" — keeps one-click chat
 * access, since macOS attaches no NSStatusItem menu (shouldAttachTrayMenu) and
 * a configured popover claims the icon click. Kill switch:
 * ELIZA_DESKTOP_TRAY_POPOVER=0 restores the direct click-to-chat toggle.
 * Requires the tray to be enabled, a platform with a popover implementation
 * (macOS only today — TRAY_POPOVER_SUPPORTED_PLATFORMS), and excludes kiosk
 * shell mode.
 */
export function shouldEnableTrayPopover(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv,
): boolean {
  if (!TRAY_POPOVER_SUPPORTED_PLATFORMS.has(platform)) {
    return false;
  }
  if (parseFalsy(env.ELIZA_DESKTOP_TRAY_POPOVER)) {
    return false;
  }
  if (!shouldCreateDesktopTray(env)) {
    return false;
  }
  if (isKioskShellMode(env, argv)) {
    return false;
  }
  return true;
}
