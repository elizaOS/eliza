/**
 * Pure derivation of the popup's status model from BackgroundState — badge,
 * title, checklist, and which primary action (manual pairing vs sync) to offer for
 * each connection state. Keeps popup.ts free of branching and makes the
 * connected / needs-pairing / error states unit-testable in isolation.
 */
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
  primaryAction: "manual_pair" | "sync";
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
        "If pairing expired, create a new pairing in Eliza and import its pairing JSON.",
      ],
      primaryAction: hasConfig ? "sync" : "manual_pair",
      primaryLabel: hasConfig ? "Sync This Browser" : "Import Pairing JSON",
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
        "This browser found a live Eliza app. Create an authenticated pairing in Eliza, then import its pairing JSON here.",
      checklist: [
        "Create a browser companion pairing in Eliza's Browser settings.",
        "Copy its pairing JSON, then import it in this extension.",
      ],
      primaryAction: "manual_pair",
      primaryLabel: "Import Pairing JSON",
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
        "Open Eliza, create an authenticated browser companion pairing, then import its pairing JSON in this extension.",
      checklist: [
        "Open Eliza in this browser profile.",
        "Create and copy a pairing JSON object from Browser settings.",
        "Return here and import it.",
      ],
      primaryAction: "manual_pair",
      primaryLabel: "Import Pairing JSON",
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
      "If pairing expired, create a new pairing in Eliza and import its pairing JSON.",
    ],
    primaryAction: "sync",
    primaryLabel: "Sync This Browser",
    showSync: true,
    summary,
  };
}
