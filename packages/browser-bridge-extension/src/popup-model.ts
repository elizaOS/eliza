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
  | "sync"
  | "grant_website_access"
  | "show_recovery";

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

export function derivePopupStatusModel(args: {
  state: BackgroundState;
  hasAllWebsiteAccess: boolean;
}): PopupStatusModel {
  const { state, hasAllWebsiteAccess } = args;
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
    if (state.connectionIssue === "recovery_required") {
      return model("error", "Reconnect this browser in Eliza", {
        kind: "show_recovery",
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
      {
        kind: "sync",
        label: "Retry connection",
      },
    );
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
