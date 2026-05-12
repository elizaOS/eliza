import type { BackgroundState } from "./protocol";

export type PopupStatusKind =
  | "connected"
  | "needs_app"
  | "needs_pairing"
  | "needs_settings"
  | "syncing"
  | "error";

export interface PopupStatusModel {
  kind: PopupStatusKind;
  badge: string;
  title: string;
  detail: string;
  checklist: string[];
  primaryAction: "auto_pair" | "sync";
  primaryLabel: string;
  showSync: boolean;
  summary: string[];
}

function isFutureIso(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function formatClock(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toLocaleTimeString();
}

export function derivePopupStatusModel(args: {
  state: BackgroundState;
  discoveredApiBaseUrl: string | null;
}): PopupStatusModel {
  const { state, discoveredApiBaseUrl } = args;
  const settings = state.settings;
  const hasConfig = Boolean(state.config);
  const browserEnabled = Boolean(settings?.enabled);
  const trackingEnabled = settings ? settings.trackingMode !== "off" : false;
  const paused = isFutureIso(settings?.pauseUntil ?? null);
  const controlEnabled = Boolean(settings?.allowBrowserControl);
  const lastSync = formatClock(state.lastSyncAt);
  const summary = [
    state.config?.apiBaseUrl
      ? `App: ${state.config.apiBaseUrl}`
      : discoveredApiBaseUrl
        ? `App: ${discoveredApiBaseUrl}`
        : "App: not found yet",
    lastSync ? `Last sync: ${lastSync}` : null,
    `Remembered tabs: ${state.rememberedTabCount}`,
    state.settingsSummary ? `Mode: ${state.settingsSummary}` : null,
  ].filter((entry): entry is string => Boolean(entry));

  if (state.syncing) {
    return {
      kind: "syncing",
      badge: "Syncing",
      title: "Checking this browser",
      detail:
        "Agent Browser Bridge is syncing tabs and permissions so Eliza can see the latest browser state.",
      checklist: [
        "Keep this browser open.",
        "If you are pairing for the first time, leave Eliza open in this same profile.",
      ],
      primaryAction: "sync",
      primaryLabel: "Syncing…",
      showSync: true,
      summary,
    };
  }

  if (state.lastError) {
    return {
      kind: "error",
      badge: "Attention",
      title: "This browser needs attention",
      detail: state.lastError,
      checklist: [
        "Try syncing this browser again.",
        "If pairing expired, Eliza will auto-connect again the next time it is open here.",
      ],
      primaryAction: hasConfig ? "sync" : "auto_pair",
      primaryLabel: hasConfig
        ? "Sync This Browser"
        : "Auto Connect This Browser",
      showSync: hasConfig,
      summary,
    };
  }

  if (hasConfig && settings && browserEnabled && trackingEnabled && !paused) {
    if (!controlEnabled) {
      return {
        kind: "needs_settings",
        badge: "Control Off",
        title: "This browser is connected, but browser control is off",
        detail:
          "Eliza can see this browser profile, but it cannot open sites or focus tabs for you until Browser control is enabled.",
        checklist: [
          "Turn on Browser control in Browser setup if you want automatic site opening.",
          "Keep it off only if you are willing to open and focus the target tab manually.",
        ],
        primaryAction: "sync",
        primaryLabel: "Sync This Browser",
        showSync: true,
        summary,
      };
    }

    return {
      kind: "connected",
      badge: "Connected",
      title: "This browser is connected to Eliza",
      detail:
        "Eliza can read and control the tabs allowed by your Browser settings in this profile.",
      checklist: [
        "Open an account-backed site in this same profile.",
        "Use Browser settings in Eliza to verify what this browser is sharing right now.",
      ],
      primaryAction: "sync",
      primaryLabel: "Sync This Browser",
      showSync: true,
      summary,
    };
  }

  if (
    hasConfig &&
    settings &&
    (!browserEnabled || !trackingEnabled || paused)
  ) {
    return {
      kind: "needs_settings",
      badge: paused ? "Paused" : "Access Off",
      title: paused
        ? "Browser access is paused"
        : "This browser is paired, but Agent Browser Bridge access is off",
      detail: paused
        ? "Eliza is paired to this browser, but Browser access is paused right now."
        : "Turn Browser access back on in Eliza so enabled connectors can see this profile again.",
      checklist: paused
        ? [
            "Clear Pause until in Browser setup, or wait for it to expire.",
            "Then sync this browser again.",
          ]
        : [
            "Turn on Enabled and choose Current tab or Active tabs in Browser setup.",
            "Then sync this browser again.",
          ],
      primaryAction: "sync",
      primaryLabel: "Sync This Browser",
      showSync: true,
      summary,
    };
  }

  if (!hasConfig && discoveredApiBaseUrl) {
    return {
      kind: "needs_pairing",
      badge: "Ready",
      title: "Eliza is open in this browser profile",
      detail:
        "This browser found a live Eliza app. Pairing should work automatically now.",
      checklist: [
        "Click Auto Connect This Browser.",
        "If it still fails, use Advanced Tools to import manual pairing JSON.",
      ],
      primaryAction: "auto_pair",
      primaryLabel: "Auto Connect This Browser",
      showSync: false,
      summary,
    };
  }

  if (!hasConfig) {
    return {
      kind: "needs_app",
      badge: "Waiting",
      title: "Open Eliza in this browser profile",
      detail:
        "Automatic connection works best when Eliza is open in the same browser profile that holds your real accounts.",
      checklist: [
        "Open Eliza in this browser profile.",
        "If you use a cloud-hosted Eliza app, log in there first.",
        "Then click Auto Connect This Browser.",
      ],
      primaryAction: "auto_pair",
      primaryLabel: "Search for Eliza Again",
      showSync: false,
      summary,
    };
  }

  return {
    kind: "error",
    badge: "Attention",
    title: "This browser needs attention",
    detail:
      "The browser is paired, but Agent Browser Bridge could not confirm a healthy connection yet.",
    checklist: [
      "Try syncing this browser again.",
      "If pairing expired, Eliza will auto-connect again the next time it is open here.",
    ],
    primaryAction: "sync",
    primaryLabel: "Sync This Browser",
    showSync: true,
    summary,
  };
}
