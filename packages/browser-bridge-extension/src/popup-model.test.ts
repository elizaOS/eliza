/**
 * Unit tests for derivePopupStatusModel across the connection states; pure
 * model, no browser environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  pairingToken: "pairing-token",
  pairingTokenExpiresAt: null,
  browser: "chrome" as const,
  profileId: "default",
  profileLabel: "Default",
  label: "Agent Browser Bridge chrome Default",
};

const enabledSettings = {
  enabled: true,
  trackingMode: "active_tabs" as const,
  allowBrowserControl: true,
  pauseUntil: null,
};

describe("derivePopupStatusModel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prioritizes syncing and error states over connection details", () => {
    expect(
      derivePopupStatusModel({
        state: baseState({ config, settings: enabledSettings, syncing: true }),
        discoveredApiBaseUrl: null,
      }),
    ).toMatchObject({
      kind: "syncing",
      primaryAction: "sync",
      showSync: true,
    });

    expect(
      derivePopupStatusModel({
        state: baseState({
          config,
          settings: enabledSettings,
          lastError: "Pairing expired",
        }),
        discoveredApiBaseUrl: null,
      }),
    ).toMatchObject({
      kind: "error",
      detail: "Pairing expired",
      primaryAction: "sync",
      showSync: true,
    });
  });

  it("classifies connected, control-off, disabled, paused, pairing, and missing-app states", () => {
    expect(
      derivePopupStatusModel({
        state: baseState({ config, settings: enabledSettings }),
        discoveredApiBaseUrl: null,
      }).kind,
    ).toBe("connected");

    expect(
      derivePopupStatusModel({
        state: baseState({
          config,
          settings: { ...enabledSettings, allowBrowserControl: false },
        }),
        discoveredApiBaseUrl: null,
      }),
    ).toMatchObject({ kind: "needs_settings", badge: "Control Off" });

    expect(
      derivePopupStatusModel({
        state: baseState({
          config,
          settings: { ...enabledSettings, enabled: false },
        }),
        discoveredApiBaseUrl: null,
      }),
    ).toMatchObject({ kind: "needs_settings", badge: "Access Off" });

    expect(
      derivePopupStatusModel({
        state: baseState({
          config,
          settings: {
            ...enabledSettings,
            pauseUntil: "2026-01-01T13:00:00.000Z",
          },
        }),
        discoveredApiBaseUrl: null,
      }),
    ).toMatchObject({ kind: "needs_settings", badge: "Paused" });

    expect(
      derivePopupStatusModel({
        state: baseState(),
        discoveredApiBaseUrl: "http://127.0.0.1:2138",
      }),
    ).toMatchObject({ kind: "needs_pairing", showSync: false });

    expect(
      derivePopupStatusModel({
        state: baseState(),
        discoveredApiBaseUrl: null,
      }),
    ).toMatchObject({ kind: "needs_app", showSync: false });
  });

  it("summarizes configured or discovered app, sync time, tab count, and mode", () => {
    const model = derivePopupStatusModel({
      state: baseState({
        config,
        settings: enabledSettings,
        lastSyncAt: "2026-01-01T11:59:00.000Z",
        rememberedTabCount: 3,
        settingsSummary: "Active tabs",
      }),
      discoveredApiBaseUrl: "http://127.0.0.1:2138",
    });

    expect(model.summary).toEqual(
      expect.arrayContaining([
        "App: https://agent.example.com",
        "Remembered tabs: 3",
        "Mode: Active tabs",
      ]),
    );
    expect(model.summary.some((entry) => entry.startsWith("Last sync: "))).toBe(
      true,
    );
  });
});
