/**
 * Browser bridge record constructor tests for companion, tab, and page-context defaults.
 */

import { describe, expect, it } from "vitest";
import {
  createBrowserBridgeCompanionStatus,
  createBrowserBridgePageContext,
  createBrowserBridgeTabSummary,
} from "./bridge-records.js";

describe("browser bridge record factories", () => {
  it("creates companion status records with pairing defaults", () => {
    const before = Date.now();
    const companion = createBrowserBridgeCompanionStatus({
      agentId: "agent-1",
      browser: "chrome",
      profileId: "default",
      profileLabel: "Default",
      label: "Chrome",
      extensionVersion: "1.0.0",
      connectionState: "connected",
      permissions: {
        tabs: true,
        scripting: true,
        activeTab: true,
        allOrigins: false,
        grantedOrigins: ["https://example.com"],
        incognitoEnabled: false,
      },
      lastSeenAt: "2026-06-02T12:00:00.000Z",
      metadata: { source: "test" },
    });
    const after = Date.now();

    expect(companion.id).toEqual(expect.any(String));
    expect(Date.parse(companion.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(companion.createdAt)).toBeLessThanOrEqual(after);
    expect(companion.updatedAt).toBe(companion.createdAt);
    expect(companion.pairedAt).toBe(companion.createdAt);
    expect(companion.pairingTokenExpiresAt).toBeNull();
    expect(companion.pairingTokenRevokedAt).toBeNull();
    expect(companion).toMatchObject({
      agentId: "agent-1",
      browser: "chrome",
      profileId: "default",
      label: "Chrome",
    });
  });

  it("creates tab summaries with timestamps", () => {
    const tab = createBrowserBridgeTabSummary({
      agentId: "agent-1",
      companionId: "companion-1",
      browser: "safari",
      profileId: "default",
      windowId: "window-1",
      tabId: "tab-1",
      url: "https://example.com",
      title: "Example",
      activeInWindow: true,
      focusedWindow: true,
      focusedActive: true,
      incognito: false,
      faviconUrl: null,
      lastSeenAt: "2026-06-02T12:00:00.000Z",
      lastFocusedAt: "2026-06-02T12:00:00.000Z",
      metadata: {},
    });

    expect(tab.id).toEqual(expect.any(String));
    expect(tab.createdAt).toEqual(expect.any(String));
    expect(tab.updatedAt).toBe(tab.createdAt);
    expect(tab).toMatchObject({
      browser: "safari",
      url: "https://example.com",
      focusedActive: true,
    });
  });

  it("creates page contexts with generated ids only", () => {
    const page = createBrowserBridgePageContext({
      agentId: "agent-1",
      browser: "chrome",
      profileId: "default",
      windowId: "window-1",
      tabId: "tab-1",
      url: "https://example.com",
      title: "Example",
      selectionText: null,
      mainText: "Hello",
      headings: ["One"],
      links: [{ text: "Docs", href: "https://example.com/docs" }],
      forms: [{ action: null, fields: ["q"] }],
      capturedAt: "2026-06-02T12:00:00.000Z",
      metadata: {},
    });

    expect(page.id).toEqual(expect.any(String));
    expect(page).toMatchObject({
      url: "https://example.com",
      mainText: "Hello",
      headings: ["One"],
    });
  });
});
