import { describe, expect, it } from "vitest";
import { derivePopupStatusModel } from "./popup-model";
import type { BackgroundState } from "./protocol";

function makeState(overrides: Partial<BackgroundState> = {}): BackgroundState {
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

describe("derivePopupStatusModel", () => {
  it("shows needs_app when no config or live app is found", () => {
    const model = derivePopupStatusModel({
      state: makeState(),
      discoveredApiBaseUrl: null,
    });
    expect(model.kind).toBe("needs_app");
    expect(model.primaryAction).toBe("auto_pair");
  });

  it("shows needs_pairing when a live app is found in the browser", () => {
    const model = derivePopupStatusModel({
      state: makeState(),
      discoveredApiBaseUrl: "http://127.0.0.1:2138",
    });
    expect(model.kind).toBe("needs_pairing");
    expect(model.primaryLabel).toMatch(/auto connect/i);
  });

  it("shows connected when config and healthy settings exist", () => {
    const model = derivePopupStatusModel({
      state: makeState({
        config: {
          apiBaseUrl: "http://127.0.0.1:2138",
          browser: "chrome",
          companionId: "companion-1",
          pairingToken: "lobr_123",
          profileId: "default",
          profileLabel: "Default",
          label: "LifeOps Browser chrome Default",
        },
        settings: {
          enabled: true,
          trackingMode: "active_tabs",
          allowBrowserControl: true,
          requireConfirmationForAccountAffecting: true,
          incognitoEnabled: false,
          siteAccessMode: "all_sites",
          grantedOrigins: [],
          blockedOrigins: [],
          maxRememberedTabs: 10,
          pauseUntil: null,
          metadata: {},
          updatedAt: null,
        },
      }),
      discoveredApiBaseUrl: "http://127.0.0.1:2138",
    });
    expect(model.kind).toBe("connected");
    expect(model.primaryAction).toBe("sync");
  });

  it("shows needs_settings when browser control is off", () => {
    const model = derivePopupStatusModel({
      state: makeState({
        config: {
          apiBaseUrl: "http://127.0.0.1:2138",
          browser: "chrome",
          companionId: "companion-1",
          pairingToken: "lobr_123",
          profileId: "default",
          profileLabel: "Default",
          label: "LifeOps Browser chrome Default",
        },
        settings: {
          enabled: true,
          trackingMode: "active_tabs",
          allowBrowserControl: false,
          requireConfirmationForAccountAffecting: true,
          incognitoEnabled: false,
          siteAccessMode: "all_sites",
          grantedOrigins: [],
          blockedOrigins: [],
          maxRememberedTabs: 10,
          pauseUntil: null,
          metadata: {},
          updatedAt: null,
        },
      }),
      discoveredApiBaseUrl: "http://127.0.0.1:2138",
    });
    expect(model.kind).toBe("needs_settings");
  });
});
