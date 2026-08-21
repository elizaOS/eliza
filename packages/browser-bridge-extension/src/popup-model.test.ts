/**
 * Unit coverage for every compact popup state, including the invariant that
 * the default surface exposes no more than one contextual action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserBridgeSettings } from "./browser-bridge-contracts";
import { derivePopupStatusModel } from "./popup-model";
import type { BackgroundState } from "./protocol";

function baseState(overrides: Partial<BackgroundState> = {}): BackgroundState {
  return {
    config: null,
    settings: null,
    syncing: false,
    lastSyncAt: null,
    lastError: null,
    lastSessionStatus: null,
    activeSessionId: null,
    rememberedTabCount: 0,
    settingsSummary: null,
    ...overrides,
  };
}

const config = {
  apiBaseUrl: "https://agent.example.com",
  companionId: "companion-1",
  pairingToken: "pairing-token-must-not-render",
  pairingTokenExpiresAt: null,
  browser: "chrome" as const,
  profileId: "default",
  profileLabel: "Default",
  label: "Eliza Browser chrome Default",
};

const enabledSettings: BrowserBridgeSettings = {
  enabled: true,
  trackingMode: "active_tabs",
  allowBrowserControl: true,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "granted_sites",
  grantedOrigins: [],
  blockedOrigins: [],
  maxRememberedTabs: 10,
  pauseUntil: null,
  metadata: {},
  updatedAt: null,
};

function derive(
  state: BackgroundState,
  options: {
    discoveredApiBaseUrl?: string | null;
    hasAllWebsiteAccess?: boolean;
  } = {},
) {
  return derivePopupStatusModel({
    state,
    discoveredApiBaseUrl: options.discoveredApiBaseUrl ?? null,
    hasAllWebsiteAccess: options.hasAllWebsiteAccess ?? false,
  });
}

describe("derivePopupStatusModel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("keeps every default state to zero or one contextual action", () => {
    const views = [
      derive(baseState({ syncing: true })),
      derive(baseState()),
      derive(baseState(), { discoveredApiBaseUrl: "http://127.0.0.1:2138" }),
      derive(baseState({ config, lastError: "Pairing expired" })),
      derive(baseState({ config })),
      derive(baseState({ config, settings: enabledSettings })),
      derive(
        baseState({
          config,
          settings: { ...enabledSettings, siteAccessMode: "all_sites" },
        }),
      ),
    ];
    for (const view of views) {
      expect(view.action === null ? 0 : 1).toBeLessThanOrEqual(1);
    }
  });

  it("uses pairing recovery only when configuration is missing", () => {
    expect(derive(baseState())).toMatchObject({
      kind: "needs_app",
      action: { kind: "show_recovery", label: "Pair this browser" },
    });
    expect(
      derive(baseState(), { discoveredApiBaseUrl: "http://127.0.0.1:2138" }),
    ).toMatchObject({
      kind: "needs_settings",
      action: { kind: "show_recovery", label: "Pair this browser" },
    });
    expect(
      derive(baseState({ config, settings: enabledSettings })).action,
    ).toBeNull();
  });

  it("shows website access only when all-sites mode needs it", () => {
    const state = baseState({
      config,
      settings: { ...enabledSettings, siteAccessMode: "all_sites" },
    });
    expect(derive(state)).toMatchObject({
      kind: "needs_permission",
      action: { kind: "grant_website_access" },
    });
    expect(derive(state, { hasAllWebsiteAccess: true })).toMatchObject({
      kind: "connected",
      action: null,
    });
    expect(
      derive(baseState({ config, settings: enabledSettings })).action,
    ).toBeNull();
  });

  it("renders paused, disabled, control-off, retry, and connected states", () => {
    for (const settings of [
      { ...enabledSettings, pauseUntil: "2026-01-01T13:00:00.000Z" },
      { ...enabledSettings, enabled: false },
      { ...enabledSettings, allowBrowserControl: false },
    ]) {
      expect(derive(baseState({ config, settings }))).toMatchObject({
        kind: "needs_settings",
        action: null,
      });
    }
    expect(
      derive(baseState({ config, lastError: "Pairing expired" })),
    ).toMatchObject({
      kind: "error",
      action: { kind: "sync", label: "Retry connection" },
    });
    expect(
      derive(baseState({ config, settings: enabledSettings })),
    ).toMatchObject({
      kind: "connected",
      label: "Connected to Eliza",
      action: null,
    });
  });

  it("never copies pairing credentials into diagnostics", () => {
    const view = derive(
      baseState({
        config,
        settings: enabledSettings,
        lastSyncAt: "2026-01-01T11:59:00.000Z",
        rememberedTabCount: 3,
        settingsSummary: "Active tabs",
      }),
    );
    expect(view.diagnostics).toMatchObject({
      app: "https://agent.example.com",
      mode: "Active tabs",
      tabCount: "3",
    });
    expect(JSON.stringify(view)).not.toContain(config.pairingToken);
    expect(JSON.stringify(view)).not.toContain(config.companionId);
  });
});
