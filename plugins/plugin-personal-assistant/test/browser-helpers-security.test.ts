// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import type { BrowserBridgeSettings } from "@elizaos/plugin-browser";
import { describe, expect, it } from "vitest";
import {
  browserOriginFromUrl,
  browserUrlAllowedBySettings,
  hashBrowserCompanionPairingToken,
  MAX_PENDING_BROWSER_PAIRING_TOKENS,
  normalizePendingBrowserPairingTokenHashes,
  redactSecretLikeText,
} from "../src/lifeops/service-helpers-browser.js";

/**
 * Browser-companion security helpers (#8795). Pairing tokens are stored only as
 * sha256 hashes (never plaintext); secret-shaped strings are redacted before
 * surfacing page text; and URL access is gated by the allow/block origin lists.
 */

describe("hashBrowserCompanionPairingToken", () => {
  it("produces a stable sha256 hex digest, distinct per token", () => {
    const h = hashBrowserCompanionPairingToken("token-abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBrowserCompanionPairingToken("token-abc")).toBe(h);
    expect(hashBrowserCompanionPairingToken("other")).not.toBe(h);
    expect(() => hashBrowserCompanionPairingToken("")).toThrow();
  });
});

describe("normalizePendingBrowserPairingTokenHashes", () => {
  it("dedupes, drops the active hash + empties, caps the list", () => {
    expect(
      normalizePendingBrowserPairingTokenHashes(
        ["a", "a", "", "active", "b"],
        "active",
      ),
    ).toEqual(["a", "b"]);
    const many = Array.from({ length: 10 }, (_, i) => `h${i}`);
    expect(normalizePendingBrowserPairingTokenHashes(many, null)).toHaveLength(
      MAX_PENDING_BROWSER_PAIRING_TOKENS,
    );
  });
});

describe("redactSecretLikeText", () => {
  it("masks secret-shaped tokens, leaves benign text", () => {
    expect(redactSecretLikeText(`key is sk_${"a".repeat(20)} ok`)).toBe(
      "key is [redacted-secret] ok",
    );
    expect(redactSecretLikeText(`gh ghp_${"b".repeat(20)}`)).toBe(
      "gh [redacted-secret]",
    );
    expect(redactSecretLikeText("nothing secret here")).toBe(
      "nothing secret here",
    );
    expect(redactSecretLikeText(null)).toBeNull();
  });
});

describe("browserOriginFromUrl / browserUrlAllowedBySettings", () => {
  const settings = (
    over: Partial<BrowserBridgeSettings>,
  ): BrowserBridgeSettings =>
    ({
      siteAccessMode: "all_sites",
      grantedOrigins: [],
      blockedOrigins: [],
      ...over,
    }) as BrowserBridgeSettings;

  it("extracts the origin, returns null for junk", () => {
    expect(browserOriginFromUrl("https://example.com/path?x=1")).toBe(
      "https://example.com",
    );
    expect(browserOriginFromUrl("not a url")).toBeNull();
  });

  it("gates by blocked + granted origin lists", () => {
    expect(browserUrlAllowedBySettings("https://ok.com/", settings({}))).toBe(
      true,
    );
    expect(
      browserUrlAllowedBySettings(
        "https://bad.com/",
        settings({ blockedOrigins: ["https://bad.com"] }),
      ),
    ).toBe(false);
    // granted_sites mode: only listed origins pass.
    expect(
      browserUrlAllowedBySettings(
        "https://x.com/",
        settings({
          siteAccessMode: "granted_sites",
          grantedOrigins: ["https://y.com"],
        }),
      ),
    ).toBe(false);
    expect(
      browserUrlAllowedBySettings(
        "https://y.com/",
        settings({
          siteAccessMode: "granted_sites",
          grantedOrigins: ["https://y.com"],
        }),
      ),
    ).toBe(true);
    expect(browserUrlAllowedBySettings("not a url", settings({}))).toBe(false);
  });
});
