/**
 * Unit coverage for the shared navigation scheme allowlist — the central
 * guard every wire-supplied navigation target (billing checkout, connector
 * OAuth, login browserUrl, server-signed download, plugin-declared link) must
 * pass before reaching `window.open`, `popup.location.href`, `location.href`,
 * or an `href`. Deterministic; no DOM or network.
 */
import { describe, expect, it } from "vitest";
import { isSafeNavigationUrl } from "./navigation-url";

describe("isSafeNavigationUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(isSafeNavigationUrl("https://checkout.stripe.com/c/pay_123")).toBe(
      true,
    );
    expect(isSafeNavigationUrl("http://localhost:31337/pair?token=abc")).toBe(
      true,
    );
    expect(isSafeNavigationUrl("http://127.0.0.1:8080/ui")).toBe(true);
  });

  it("rejects script-capable and file schemes", () => {
    expect(isSafeNavigationUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeNavigationUrl("JavaScript:alert(1)")).toBe(false);
    expect(
      isSafeNavigationUrl("data:text/html,<script>alert(1)</script>"),
    ).toBe(false);
    expect(isSafeNavigationUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeNavigationUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects control-char-obfuscated schemes the way the browser parses them", () => {
    // The WHATWG parser strips tab/newline before resolving the scheme, so
    // these are `javascript:` URLs and must fail closed.
    expect(isSafeNavigationUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeNavigationUrl("java\nscript:alert(1)")).toBe(false);
  });

  it("rejects arbitrary custom schemes by default", () => {
    expect(isSafeNavigationUrl("customapp://do-thing")).toBe(false);
    expect(isSafeNavigationUrl("sms:+18087881821")).toBe(false);
  });

  it("accepts caller-declared extra schemes only", () => {
    expect(isSafeNavigationUrl("sms:+18087881821", ["sms:"])).toBe(true);
    expect(isSafeNavigationUrl("tel:+18087881821", ["sms:"])).toBe(false);
    expect(isSafeNavigationUrl("javascript:alert(1)", ["sms:"])).toBe(false);
  });

  it("rejects relative, root-relative, scheme-relative, and empty input", () => {
    expect(isSafeNavigationUrl("/cloud/billing")).toBe(false);
    expect(isSafeNavigationUrl("//attacker.example/x")).toBe(false);
    expect(isSafeNavigationUrl("settings/billing")).toBe(false);
    expect(isSafeNavigationUrl("")).toBe(false);
    expect(isSafeNavigationUrl("   ")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isSafeNavigationUrl(undefined)).toBe(false);
    expect(isSafeNavigationUrl(null)).toBe(false);
    expect(isSafeNavigationUrl(42)).toBe(false);
    expect(isSafeNavigationUrl({ href: "https://x.example" })).toBe(false);
  });
});
