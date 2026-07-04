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
 * Whether a tray click should open the widget popover instead of (just) showing
 * the main window. Opt-in (default OFF) via ELIZA_DESKTOP_TRAY_POPOVER=1;
 * requires the tray to be enabled, a platform with a popover implementation, and
 * excludes kiosk shell mode.
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
