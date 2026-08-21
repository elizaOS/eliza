/**
 * Derives the compact popup status and its sole contextual action from the
 * background connection state. Diagnostics are intentionally non-secret and
 * remain separate from the default one-line status surface.
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
  | "show_recovery"
  | "sync"
  | "grant_website_access";

export interface PopupStatusModel {
  kind: PopupStatusKind;
  label: string;
  action: { kind: PopupContextualAction; label: string } | null;
  diagnostics: {
    app: string;
    lastSync: string;
    mode: string;
    tabCount: string;
  };
  showDisconnect: boolean;
}

function isFutureIso(value: string | null | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function formatClock(value: string | null): string {
  if (!value) return "Not yet";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleTimeString()
    : "Not available";
}

export function derivePopupStatusModel(args: {
  state: BackgroundState;
  discoveredApiBaseUrl: string | null;
  hasAllWebsiteAccess: boolean;
}): PopupStatusModel {
  const { state, discoveredApiBaseUrl, hasAllWebsiteAccess } = args;
  const settings = state.settings;
  const hasConfig = Boolean(state.config);
  const diagnostics = {
    app: state.config?.apiBaseUrl ?? discoveredApiBaseUrl ?? "Not found",
    lastSync: formatClock(state.lastSyncAt),
    mode: state.settingsSummary ?? "Not available",
    tabCount: String(state.rememberedTabCount),
  };
  const model = (
    kind: PopupStatusKind,
    label: string,
    action: PopupStatusModel["action"] = null,
  ): PopupStatusModel => ({
    kind,
    label,
    action,
    diagnostics,
    showDisconnect: hasConfig,
  });

  if (state.syncing) {
    return model("syncing", "Connecting to Eliza…");
  }

  if (!hasConfig) {
    if (discoveredApiBaseUrl) {
      return model(
        state.lastError ? "error" : "needs_settings",
        state.lastError ? "Pairing needs attention" : "Eliza is ready to pair",
        { kind: "show_recovery", label: "Pair this browser" },
      );
    }
    return model("needs_app", "Open Eliza, then pair this browser", {
      kind: "show_recovery",
      label: "Pair this browser",
    });
  }

  if (state.lastError) {
    return model("error", "Connection needs attention", {
      kind: "sync",
      label: "Retry connection",
    });
  }

  if (!settings) {
    return model("syncing", "Finishing connection to Eliza…", {
      kind: "sync",
      label: "Retry connection",
    });
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

  return model("connected", "Connected to Eliza");
}
