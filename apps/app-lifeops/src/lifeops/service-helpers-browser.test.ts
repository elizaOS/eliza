import type { LifeOpsBrowserSettings } from "@elizaos/app-lifeops/contracts";
import { describe, expect, it } from "vitest";
import {
  browserUrlAllowedBySettings,
  normalizePageLinks,
  normalizePendingBrowserPairingTokenHashes,
  redactSecretLikeText,
} from "./service-helpers-browser.js";
import { LifeOpsServiceError } from "./service-types.js";

const baseSettings: LifeOpsBrowserSettings = {
  enabled: true,
  trackingMode: "current_tab",
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

describe("service-helpers-browser", () => {
  it("enforces granted browser origins exactly", () => {
    const settings: LifeOpsBrowserSettings = {
      ...baseSettings,
      siteAccessMode: "granted_sites",
      grantedOrigins: ["https://example.com"],
    };

    expect(
      browserUrlAllowedBySettings("https://example.com/path", settings),
    ).toBe(true);
    expect(
      browserUrlAllowedBySettings("https://evil-example.com/path", settings),
    ).toBe(false);
  });

  it("redacts known secret-like tokens from captured page text", () => {
    expect(redactSecretLikeText("token sk_live_1234567890abcdef here")).toBe(
      "token [redacted-secret] here",
    );
  });

  it("rejects malformed page links instead of casting them into DTOs", () => {
    expect(() =>
      normalizePageLinks([{ text: "Docs" }], "pageContexts[0].links"),
    ).toThrow(LifeOpsServiceError);
  });

  it("keeps bounded pending pairing-token hashes without the active token", () => {
    expect(
      normalizePendingBrowserPairingTokenHashes(
        ["new", "active", "old-1", "old-2", "old-3", "old-4"],
        "active",
      ),
    ).toEqual(["new", "old-1", "old-2", "old-3"]);
  });
});
