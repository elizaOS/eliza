/**
 * Adversarial tests for the last-moment browser action authorization gate.
 */
import { describe, expect, it } from "vitest";
import { browserActionAuthorizationError } from "./action-authorization";
import type { BrowserBridgeSettings } from "./browser-bridge-contracts";

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

function authorize(overrides: Partial<BrowserBridgeSettings> = {}) {
  return browserActionAuthorizationError({
    settings: { ...settings, ...overrides },
    target: {
      url: "https://allowed.example/account",
      incognito: false,
      focusedActive: true,
    },
    grantedOrigins: ["https://allowed.example/*"],
    currentFocusedUrl: "https://allowed.example/home",
    now: new Date("2026-08-17T12:00:00.000Z"),
  });
}

describe("browserActionAuthorizationError", () => {
  it("fails closed when control is revoked or the bridge becomes paused", () => {
    expect(authorize({ enabled: false })).toMatch(/disabled/i);
    expect(authorize({ trackingMode: "off" })).toMatch(/disabled/i);
    expect(authorize({ allowBrowserControl: false })).toMatch(/disabled/i);
    expect(authorize({ pauseUntil: "2026-08-17T12:01:00.000Z" })).toMatch(
      /paused/i,
    );
  });

  it("requires both the browser's effective grant and the server site grant", () => {
    const target = {
      url: "https://allowed.example/account",
      incognito: false,
      focusedActive: true,
    };
    expect(
      browserActionAuthorizationError({
        settings: { ...settings, siteAccessMode: "granted_sites" },
        target,
        grantedOrigins: ["https://allowed.example/*"],
        currentFocusedUrl: target.url,
      }),
    ).toMatch(/grant list/i);
    expect(
      browserActionAuthorizationError({
        settings: {
          ...settings,
          siteAccessMode: "granted_sites",
          grantedOrigins: ["https://allowed.example"],
        },
        target,
        grantedOrigins: [],
        currentFocusedUrl: target.url,
      }),
    ).toMatch(/browser has not granted/i);
  });

  it("rejects a site blocked after a session was claimed", () => {
    expect(authorize({ blockedOrigins: ["https://allowed.example/"] })).toMatch(
      /blocked/i,
    );
  });

  it("matches the visible host block across schemes, ports, and subdomains", () => {
    expect(authorize({ blockedOrigins: ["allowed.example"] })).toMatch(
      /blocked/i,
    );
    expect(
      browserActionAuthorizationError({
        settings: { ...settings, blockedOrigins: ["https://example"] },
        target: {
          url: "http://pay.example:8443/account",
          incognito: false,
          focusedActive: true,
        },
        grantedOrigins: ["<all_urls>"],
        currentFocusedUrl: "http://pay.example:8443/account",
      }),
    ).toMatch(/blocked/i);
  });

  it("does not let current-site mode navigate the focused tab cross-origin", () => {
    expect(
      browserActionAuthorizationError({
        settings: { ...settings, siteAccessMode: "current_site_only" },
        target: {
          url: "https://other.example/",
          incognito: false,
          focusedActive: true,
        },
        grantedOrigins: ["https://other.example/*"],
        currentFocusedUrl: "https://allowed.example/",
      }),
    ).toMatch(/currently focused site/i);
  });

  it("rejects incognito actions unless both browser and server allow them", () => {
    expect(
      browserActionAuthorizationError({
        settings,
        target: {
          url: "https://allowed.example/",
          incognito: true,
          focusedActive: true,
        },
        grantedOrigins: ["https://allowed.example/*"],
        currentFocusedUrl: "https://allowed.example/",
      }),
    ).toMatch(/incognito/i);
  });
});
