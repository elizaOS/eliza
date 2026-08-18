/**
 * Fail-closed authorization for companion-directed browser actions. The
 * service worker calls this with freshly fetched server settings and the
 * browser's current effective host grants immediately before every action.
 */
import type { BrowserBridgeSettings } from "./browser-bridge-contracts";
import { urlMatchesGrantedOrigins } from "./tab-cache";

export interface ActionAuthorizationTarget {
  url: string;
  incognito: boolean;
  focusedActive: boolean;
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin.replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function isPaused(settings: BrowserBridgeSettings, now: Date): boolean {
  return (
    typeof settings.pauseUntil === "string" &&
    Date.parse(settings.pauseUntil) > now.getTime()
  );
}

export function browserActionAuthorizationError(args: {
  settings: BrowserBridgeSettings;
  target: ActionAuthorizationTarget;
  grantedOrigins: readonly string[];
  currentFocusedUrl: string | null;
  now?: Date;
}): string | null {
  const {
    settings,
    target,
    grantedOrigins,
    currentFocusedUrl,
    now = new Date(),
  } = args;
  if (!settings.enabled || settings.trackingMode === "off") {
    return "Browser bridge is disabled.";
  }
  if (!settings.allowBrowserControl) {
    return "Browser control is disabled.";
  }
  if (isPaused(settings, now)) {
    return "Browser bridge is paused.";
  }
  if (target.incognito && !settings.incognitoEnabled) {
    return "Browser control is not allowed in incognito windows.";
  }
  const targetOrigin = normalizeOrigin(target.url);
  if (!targetOrigin || !urlMatchesGrantedOrigins(target.url, grantedOrigins)) {
    return "The browser has not granted access to the target site.";
  }
  if (new Set(settings.blockedOrigins.map(normalizeOrigin)).has(targetOrigin)) {
    return "The target site is blocked by browser bridge settings.";
  }
  if (settings.siteAccessMode === "granted_sites") {
    const settingsGrants = new Set(
      settings.grantedOrigins.map(normalizeOrigin),
    );
    if (!settingsGrants.has(targetOrigin)) {
      return "The target site is not in the browser bridge site grant list.";
    }
  }
  if (settings.siteAccessMode === "current_site_only") {
    const focusedOrigin = currentFocusedUrl
      ? normalizeOrigin(currentFocusedUrl)
      : null;
    if (!target.focusedActive || focusedOrigin !== targetOrigin) {
      return "Browser control is limited to the currently focused site.";
    }
  }
  return null;
}
