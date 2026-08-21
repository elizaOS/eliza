/**
 * Verifies that tab synchronization cannot expose URL/title metadata outside
 * the browser's actual host grants, even when agent settings request all sites.
 */

import { describe, expect, it } from "vitest";
import type { BrowserBridgeSettings } from "./browser-bridge-contracts";
import {
  type RememberedTab,
  selectTabsForSync,
  urlMatchesGrantedOrigins,
} from "./tab-cache";

const settings: BrowserBridgeSettings = {
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
};

function tab(url: string): RememberedTab {
  return {
    browser: "firefox",
    profileId: "default",
    windowId: "1",
    tabId: url,
    url,
    title: url,
    activeInWindow: true,
    focusedWindow: true,
    focusedActive: true,
    incognito: false,
    faviconUrl: null,
    lastSeenAt: "2026-08-18T00:00:00.000Z",
    lastFocusedAt: "2026-08-18T00:00:00.000Z",
    metadata: {},
  };
}

describe("browser host grant enforcement", () => {
  it("matches exact, wildcard-subdomain, and all-URL grants", () => {
    expect(
      urlMatchesGrantedOrigins("https://eliza.dev/chat", [
        "https://eliza.dev/*",
      ]),
    ).toBe(true);
    expect(
      urlMatchesGrantedOrigins("https://app.eliza.dev/chat", [
        "https://*.eliza.dev/*",
      ]),
    ).toBe(true);
    expect(
      urlMatchesGrantedOrigins("http://127.0.0.1:31337/chat", [
        "http://127.0.0.1/*",
      ]),
    ).toBe(true);
    expect(
      urlMatchesGrantedOrigins("https://private.example/chat", ["<all_urls>"]),
    ).toBe(true);
  });

  it("does not sync ungranted tab metadata under all-sites settings", () => {
    const allowed = tab("https://eliza.dev/chat");
    const privateTab = tab("https://private.example/account");
    expect(
      selectTabsForSync({
        previous: [],
        snapshot: [allowed, privateTab],
        settings,
        grantedOrigins: ["https://eliza.dev/*"],
        fallbackMaxRememberedTabs: 10,
      }).map((candidate) => candidate.url),
    ).toEqual([allowed.url]);
  });
});
