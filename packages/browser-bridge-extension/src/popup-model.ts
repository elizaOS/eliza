/**
 * Derives the compact popup status and its sole contextual action from the
 * background connection state. The model deliberately contains no connection
 * diagnostics or credential-adjacent values.
 */
import type { BackgroundState } from "./protocol";

export type PopupStatusKind =
  | "connected"
  | "needs_app"
  | "needs_settings"
  | "needs_permission"
  | "syncing"
  | "error";

export type PopupContextualAction =
  | "grant_website_access"
  | "grant_current_site"
  | "recover";

export interface PopupStatusModel {
  kind: PopupStatusKind;
  label: string;
  action: { kind: PopupContextualAction; label: string } | null;
  showDisconnect: boolean;
}

function isFutureIso(value: string | null | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function normalizeHttpOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    // error-policy:J3 Browser-owned tab and setting URLs are untrusted input.
    return null;
  }
}

/** Resolves the one exact browser permission the current policy can use. */
export function requiredCurrentSiteOriginPattern(
  state: BackgroundState,
  activeTabUrl: string | null,
): string | null {
  const origin = activeTabUrl ? normalizeHttpOrigin(activeTabUrl) : null;
  const settings = state.settings;
  if (!origin || !settings) return null;
  const settingAllowsCurrentSite =
    settings.siteAccessMode === "current_site_only" ||
    (settings.siteAccessMode === "granted_sites" &&
      settings.grantedOrigins.some(
        (candidate) => normalizeHttpOrigin(candidate) === origin,
      ));
  return settingAllowsCurrentSite ? `${origin}/*` : null;
}

export function derivePopupStatusModel(args: {
  state: BackgroundState;
  hasAllWebsiteAccess: boolean;
  currentSitePermissionRequired: boolean;
}): PopupStatusModel {
  const { state, hasAllWebsiteAccess, currentSitePermissionRequired } = args;
  const settings = state.settings;
  const hasConfig = Boolean(state.config);
  const model = (
    kind: PopupStatusKind,
    label: string,
    action: PopupStatusModel["action"] = null,
  ): PopupStatusModel => ({
    kind,
    label,
    action,
    showDisconnect: hasConfig,
  });

  if (state.syncing) {
    return model("syncing", "Connecting to Eliza…");
  }

  if (!hasConfig) {
    if (state.connectionIssue === "owner_disconnected") {
      return model("needs_settings", "Disconnected from Eliza", {
        kind: "recover",
        label: "Reconnect",
      });
    }
    if (state.connectionIssue === "recovery_required") {
      return model("error", "Reconnect this browser in Eliza", {
        kind: "recover",
        label: "Reconnect",
      });
    }
    const connectionLabel =
      state.connectionIssue === "app_not_authenticated"
        ? "Sign in to Eliza"
        : state.connectionIssue === "app_not_running"
          ? "Open Eliza to connect"
          : null;
    return model(
      connectionLabel === null && state.lastError ? "error" : "needs_app",
      connectionLabel ??
        (state.lastError
          ? "Connection needs attention"
          : "Open Eliza to connect"),
    );
  }

  if (!settings) {
    return state.lastError
      ? model("error", "Connection needs attention")
      : model("syncing", "Finishing connection to Eliza…");
  }

  if (isFutureIso(settings.pauseUntil)) {
    return model("needs_settings", "Connected · Browser access is paused");
  }

  if (!settings.enabled || settings.trackingMode === "off") {
    return model("needs_settings", "Connected · Browser access is off");
  }

  if (!settings.allowBrowserControl) {
    return model("needs_settings", "Connected · Browser control is off");
  }

  if (settings.siteAccessMode === "all_sites" && !hasAllWebsiteAccess) {
    return model("needs_permission", "Connected · Website access needed", {
      kind: "grant_website_access",
      label: "Grant website access",
    });
  }

  if (currentSitePermissionRequired) {
    return model("needs_permission", "Connected · Allow this site", {
      kind: "grant_current_site",
      label: "Allow this site",
    });
  }

  if (state.lastError) {
    return model("error", "Connection needs attention");
  }

  return model("connected", "Connected to Eliza");
}
