/**
 * Browser bridge policy tests for token expiry and URL focus helpers.
 */

import { describe, expect, it } from "vitest";
import {
  browserBridgeDomainFromUrl,
  DEFAULT_BROWSER_COMPANION_PAIRING_TOKEN_TTL_MS,
  resolveBrowserBridgeCompanionPairingTokenExpiresAt,
  resolveBrowserBridgeCompanionPairingTokenTtlMs,
} from "./bridge-policy.js";

describe("browser bridge policy", () => {
  it("resolves companion pairing token TTL from env with a stable fallback", () => {
    expect(resolveBrowserBridgeCompanionPairingTokenTtlMs({})).toBe(
      DEFAULT_BROWSER_COMPANION_PAIRING_TOKEN_TTL_MS,
    );
    expect(
      resolveBrowserBridgeCompanionPairingTokenTtlMs({
        BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS: "60000.9",
      }),
    ).toBe(60000);
    expect(
      resolveBrowserBridgeCompanionPairingTokenTtlMs({
        BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS: "-1",
        ELIZA_BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS: "90000",
      }),
    ).toBe(DEFAULT_BROWSER_COMPANION_PAIRING_TOKEN_TTL_MS);
    expect(
      resolveBrowserBridgeCompanionPairingTokenTtlMs({
        ELIZA_BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS: "90000",
      }),
    ).toBe(90000);
  });

  it("builds companion pairing expiry timestamps", () => {
    expect(
      resolveBrowserBridgeCompanionPairingTokenExpiresAt(
        Date.parse("2026-06-02T12:00:00.000Z"),
        { BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS: "60000" },
      ),
    ).toBe("2026-06-02T12:01:00.000Z");
  });

  it("normalizes browser domains from web urls only", () => {
    expect(browserBridgeDomainFromUrl("https://Example.COM./path")).toBe(
      "example.com",
    );
    expect(browserBridgeDomainFromUrl("http://sub.example.com")).toBe(
      "sub.example.com",
    );
    expect(browserBridgeDomainFromUrl("file:///tmp/a.html")).toBeNull();
    expect(browserBridgeDomainFromUrl("not a url")).toBeNull();
  });
});
