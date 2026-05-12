import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgePermissionState,
  BrowserBridgeSettings,
} from "@elizaos/plugin-browser";

export const BROWSER_BRIDGE_RECENT_CONTACT_WINDOW_MS = 5 * 60_000;

export type BrowserBridgeReadinessState =
  | "ready"
  | "disabled"
  | "tracking_off"
  | "paused"
  | "control_disabled"
  | "no_companion"
  | "stale"
  | "permission_blocked";

export interface BrowserBridgeReadiness {
  state: BrowserBridgeReadinessState;
  ready: boolean;
  connectedCompanions: BrowserBridgeCompanionStatus[];
  recentConnectedCompanions: BrowserBridgeCompanionStatus[];
  primaryCompanion: BrowserBridgeCompanionStatus | null;
}

export function isBrowserBridgePaused(
  settings: Pick<BrowserBridgeSettings, "pauseUntil">,
  nowMs = Date.now(),
): boolean {
  if (!settings.pauseUntil) {
    return false;
  }
  const pauseUntilMs = Date.parse(settings.pauseUntil);
  return Number.isFinite(pauseUntilMs) && pauseUntilMs > nowMs;
}

export function browserBridgeCompanionIsRecent(
  companion: Pick<BrowserBridgeCompanionStatus, "lastSeenAt">,
  nowMs = Date.now(),
  recentWindowMs = BROWSER_BRIDGE_RECENT_CONTACT_WINDOW_MS,
): boolean {
  if (!companion.lastSeenAt) {
    return false;
  }
  const lastSeenMs = Date.parse(companion.lastSeenAt);
  return Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < recentWindowMs;
}

export function browserBridgeSiteAccessReady(
  settings: Pick<BrowserBridgeSettings, "siteAccessMode" | "grantedOrigins">,
  permissions: BrowserBridgePermissionState,
): boolean {
  switch (settings.siteAccessMode) {
    case "all_sites":
      return permissions.allOrigins;
    case "granted_sites":
      return (
        permissions.allOrigins ||
        (settings.grantedOrigins.length > 0 &&
          permissions.grantedOrigins.length > 0)
      );
    case "current_site_only":
      return permissions.activeTab;
    default:
      return false;
  }
}

export function browserBridgePermissionsReady(
  settings: Pick<BrowserBridgeSettings, "siteAccessMode" | "grantedOrigins">,
  permissions: BrowserBridgePermissionState,
): boolean {
  return (
    permissions.tabs &&
    permissions.scripting &&
    permissions.activeTab &&
    browserBridgeSiteAccessReady(settings, permissions)
  );
}

export function resolveBrowserBridgeReadiness(
  settings: BrowserBridgeSettings,
  companions: readonly BrowserBridgeCompanionStatus[],
  nowMs = Date.now(),
): BrowserBridgeReadiness {
  const connectedCompanions = companions.filter(
    (companion) => companion.connectionState === "connected",
  );
  const recentConnectedCompanions = connectedCompanions.filter((companion) =>
    browserBridgeCompanionIsRecent(companion, nowMs),
  );
  const primaryCompanion =
    recentConnectedCompanions[0] ??
    connectedCompanions[0] ??
    companions[0] ??
    null;

  const base = {
    connectedCompanions,
    recentConnectedCompanions,
    primaryCompanion,
  };

  if (!settings.enabled) {
    return { ...base, ready: false, state: "disabled" };
  }
  if (settings.trackingMode === "off") {
    return { ...base, ready: false, state: "tracking_off" };
  }
  if (isBrowserBridgePaused(settings, nowMs)) {
    return { ...base, ready: false, state: "paused" };
  }
  if (!settings.allowBrowserControl) {
    return { ...base, ready: false, state: "control_disabled" };
  }
  if (companions.length === 0) {
    return { ...base, ready: false, state: "no_companion" };
  }
  if (
    connectedCompanions.length === 0 &&
    companions.some(
      (companion) => companion.connectionState === "permission_blocked",
    )
  ) {
    return { ...base, ready: false, state: "permission_blocked" };
  }
  if (recentConnectedCompanions.length === 0) {
    return { ...base, ready: false, state: "stale" };
  }
  if (
    recentConnectedCompanions.some((companion) =>
      browserBridgePermissionsReady(settings, companion.permissions),
    )
  ) {
    return { ...base, ready: true, state: "ready" };
  }
  return { ...base, ready: false, state: "permission_blocked" };
}
