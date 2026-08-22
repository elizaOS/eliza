/**
 * Browser companion preflight tests verify settings-version binding without
 * reading or persisting browser state before authorization succeeds.
 */

import type { BrowserBridgeSettings } from "@elizaos/plugin-browser";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserDomain,
  browserBridgeSettingsVersion,
} from "./browser-service.js";

const settings: BrowserBridgeSettings = {
  enabled: true,
  trackingMode: "active_tabs",
  allowBrowserControl: false,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "all_sites",
  grantedOrigins: [],
  blockedOrigins: [],
  maxRememberedTabs: 20,
  pauseUntil: null,
  metadata: {},
  updatedAt: null,
};

function harness() {
  const companion = {
    id: "companion-1",
    browser: "chrome",
    profileId: "profile-1",
  } as const;
  const domain = new BrowserDomain(
    {} as ConstructorParameters<typeof BrowserDomain>[0],
    {
      getBrowserSettingsInternal: vi.fn(async () => settings),
      isBrowserPaused: vi.fn(() => false),
    } as unknown as ConstructorParameters<typeof BrowserDomain>[1],
  );
  vi.spyOn(domain, "requireBrowserCompanion").mockResolvedValue(
    companion as Awaited<ReturnType<typeof domain.requireBrowserCompanion>>,
  );
  const syncBrowserState = vi
    .spyOn(domain, "syncBrowserState")
    .mockResolvedValue({ companion, tabs: [], currentPage: null } as never);
  return { companion, domain, syncBrowserState };
}

const companionRequest = {
  companion: {
    browser: "chrome" as const,
    profileId: "profile-1",
    label: "Chrome profile",
  },
};

describe("BrowserDomain companion preflight", () => {
  it("returns only identity, effective settings, and a nonempty version", async () => {
    const { domain, syncBrowserState } = harness();
    const response = await domain.preflightBrowserCompanion(
      "companion-1",
      "token",
      companionRequest,
    );
    expect(Object.keys(response).sort()).toEqual([
      "companion",
      "settings",
      "settingsVersion",
    ]);
    expect(response.settingsVersion).toBe(
      browserBridgeSettingsVersion(settings),
    );
    expect(response.settingsVersion.length).toBeGreaterThan(20);
    expect(syncBrowserState).not.toHaveBeenCalled();
  });

  it("rejects a stale version before state persistence and accepts a fresh version", async () => {
    const { domain, syncBrowserState } = harness();
    const request = { ...companionRequest, tabs: [], pageContexts: [] };
    await expect(
      domain.syncBrowserCompanion("companion-1", "token", {
        ...request,
        settingsVersion: "stale",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "browser_bridge_settings_stale",
    });
    expect(syncBrowserState).not.toHaveBeenCalled();

    await expect(
      domain.syncBrowserCompanion("companion-1", "token", {
        ...request,
        settingsVersion: browserBridgeSettingsVersion(settings),
      }),
    ).resolves.toMatchObject({
      tabs: [],
      settingsVersion: browserBridgeSettingsVersion(settings),
    });
    expect(syncBrowserState).toHaveBeenCalledOnce();
  });
});
