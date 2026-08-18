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
 * Whether an explicitly configured macOS build should launch dockless with the
 * menu-bar item as its resting surface. The normal app keeps its full window
 * and Dock presence. Windows and Linux never use this accessory policy.
 */
export function shouldStartTrayFirst(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv,
): boolean {
  if (platform !== "darwin") {
    return false;
  }
  if (!parseTruthy(env.ELIZA_DESKTOP_TRAY_FIRST)) {
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
 * macOS 26.5's Control Center can accept an NSStatusItem while repeatedly
 * rejecting its NSStatusItemView scene. AppKit still reports non-zero bounds,
 * so runtime visibility probes cannot distinguish the broken item. Keep a Dock
 * recovery surface on that specific Darwin release until Apple ships the next
 * kernel line.
 */
export function hasKnownMacosStatusItemSceneRegression(
  platform: NodeJS.Platform = process.platform,
  kernelRelease = "",
): boolean {
  return platform === "darwin" && /^25\.5(?:\.|$)/.test(kernelRelease);
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
 * The native menu is the primary menu-bar/taskbar contract on every desktop
 * platform. On macOS AppKit owns a status item with an attached menu, so icon
 * clicks open the real native menu instead of a renderer popover. The bottom
 * Flow-style pill and global shortcut remain the direct chat launchers.
 * `ELIZA_DESKTOP_TRAY_MENU=0` is an emergency compatibility escape hatch.
 */
export function shouldAttachTrayMenu(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  void platform;
  return !parseFalsy(env.ELIZA_DESKTOP_TRAY_MENU);
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
 * Whether a tray click should open the renderer widget popover instead of the
 * native menu. Default OFF: the production taskbar/menu-bar surface is a real
 * native Windows/Quit menu. `ELIZA_DESKTOP_TRAY_POPOVER=1` remains available
 * for the experimental renderer launcher and requires disabling the native
 * menu separately. Requires the tray and excludes kiosk shell mode.
 */
export function shouldEnableTrayPopover(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv,
): boolean {
  if (!TRAY_POPOVER_SUPPORTED_PLATFORMS.has(platform)) {
    return false;
  }
  if (!parseTruthy(env.ELIZA_DESKTOP_TRAY_POPOVER)) {
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
