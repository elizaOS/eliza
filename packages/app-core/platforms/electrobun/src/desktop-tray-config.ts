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
 * Whether the app should launch tray-first: no main window at startup, the
 * tray icon as the only surface, and the window created lazily on demand.
 *
 * Opt-in (default OFF). Tray-first is macOS-only — on Windows (CEF) the UI
 * message loop must be running before setApplicationMenu(), and Linux tray
 * support varies, so both keep a boot window. It also requires the tray to be
 * enabled and excludes kiosk shell mode (kiosk wants a fullscreen window).
 * Enable with ELIZA_DESKTOP_TRAY_FIRST=1.
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
 * Whether the app should launch into the first-run onboarding overlay: a
 * full-screen, borderless, transparent, click-through (passthrough)
 * always-on-top window that renders only the floating onboarding card instead
 * of the opaque dashboard. Empty (transparent) regions pass clicks straight
 * through to the desktop behind; the card itself is interactive.
 *
 * Opt-in (default OFF). macOS-only — transparent + region-based passthrough is
 * a WKWebView capability we only rely on there — and excludes kiosk shell mode
 * (kiosk wants the fullscreen appliance window). Enable with
 * ELIZA_DESKTOP_ONBOARDING_OVERLAY=1.
 */
export function shouldStartOnboardingOverlay(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv,
): boolean {
  if (platform !== "darwin") {
    return false;
  }
  if (!parseTruthy(env.ELIZA_DESKTOP_ONBOARDING_OVERLAY)) {
    return false;
  }
  if (isKioskShellMode(env, argv)) {
    return false;
  }
  return true;
}
