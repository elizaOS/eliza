/**
 * Unit coverage for every compact popup state, including the invariant that
 * the default surface exposes no more than one contextual action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserBridgeSettings } from "./browser-bridge-contracts";
import {
  derivePopupStatusModel,
  requiredCurrentSiteOriginPattern,
} from "./popup-model";
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
    connectionIssue: null,
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
  options: { hasAllWebsiteAccess?: boolean } = {},
) {
  return derivePopupStatusModel({
    state,
    hasAllWebsiteAccess: options.hasAllWebsiteAccess ?? false,
    currentSitePermissionRequired: false,
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

  it("leaves automatic connection states action-free", () => {
    expect(derive(baseState())).toMatchObject({
      kind: "needs_app",
      action: null,
    });
    expect(
      derive(baseState({ config, settings: enabledSettings })).action,
    ).toBeNull();
  });

  it("keeps native app and authentication failures actionable without diagnostics", () => {
    expect(
      derive(
        baseState({
          connectionIssue: "app_not_running",
          lastError: "startup: native host detail that must not render",
        }),
      ),
    ).toMatchObject({
      kind: "needs_app",
      label: "Open Eliza to connect",
      action: null,
    });
    expect(
      derive(
        baseState({
          connectionIssue: "app_not_authenticated",
          lastError: "startup: raw authentication detail",
        }),
      ),
    ).toMatchObject({
      kind: "needs_app",
      label: "Sign in to Eliza",
      action: null,
    });
  });

  it("routes revoked or invalid credentials to recovery instead of an ineffective retry", () => {
    expect(
      derive(
        baseState({
          connectionIssue: "recovery_required",
          lastError: "pairing token revoked: raw native detail",
        }),
      ),
    ).toMatchObject({
      kind: "error",
      label: "Reset in Eliza, then reconnect",
      action: { kind: "recover", label: "Reconnect" },
    });
  });

  it("keeps an explicit disconnect reversible without resuming in the background", () => {
    expect(
      derive(
        baseState({
          connectionIssue: "owner_disconnected",
          lastError: null,
        }),
      ),
    ).toMatchObject({
      kind: "needs_settings",
      label: "Disconnected from Eliza",
      action: { kind: "recover", label: "Reconnect" },
    });
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
    expect(
      derive({
        ...state,
        lastError:
          "website blocker sync failed: browser permission is required",
      }),
    ).toMatchObject({
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

  it("offers one exact-site browser permission when the active site needs it", () => {
    expect(
      derivePopupStatusModel({
        state: baseState({
          config,
          settings: {
            ...enabledSettings,
            siteAccessMode: "current_site_only",
          },
        }),
        hasAllWebsiteAccess: false,
        currentSitePermissionRequired: true,
      }),
    ).toMatchObject({
      kind: "needs_permission",
      label: "Connected · Allow this site",
      action: { kind: "grant_current_site", label: "Allow this site" },
    });
  });

  it("derives exact current-site grants and rejects unrelated or privileged URLs", () => {
    const currentSiteState = baseState({
      config,
      settings: {
        ...enabledSettings,
        siteAccessMode: "current_site_only",
      },
    });
    expect(
      requiredCurrentSiteOriginPattern(
        currentSiteState,
        "https://Accounts.Example.com/login",
      ),
    ).toBe("https://accounts.example.com/*");
    expect(
      requiredCurrentSiteOriginPattern(currentSiteState, "chrome://settings"),
    ).toBeNull();

    const grantedSiteState = baseState({
      config,
      settings: {
        ...enabledSettings,
        grantedOrigins: ["https://allowed.example"],
      },
    });
    expect(
      requiredCurrentSiteOriginPattern(
        grantedSiteState,
        "https://allowed.example/account",
      ),
    ).toBe("https://allowed.example/*");
    expect(
      requiredCurrentSiteOriginPattern(
        grantedSiteState,
        "https://unlisted.example/",
      ),
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
      action: null,
    });
    expect(
      derive(baseState({ config, settings: enabledSettings })),
    ).toMatchObject({
      kind: "connected",
      label: "Connected to Eliza",
      action: null,
    });
  });

  it("never copies pairing credentials into the compact status model", () => {
    const view = derive(
      baseState({
        config,
        settings: enabledSettings,
        lastSyncAt: "2026-01-01T11:59:00.000Z",
        rememberedTabCount: 3,
        settingsSummary: "Active tabs",
      }),
    );
    expect(JSON.stringify(view)).not.toContain(config.pairingToken);
    expect(JSON.stringify(view)).not.toContain(config.companionId);
    expect(JSON.stringify(view)).not.toContain(config.apiBaseUrl);
  });
});
