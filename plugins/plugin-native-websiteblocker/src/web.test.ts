import { describe, expect, it } from "vitest";

import { normalizeHostname, validateStartBlockOptions } from "./web";

// Single-path engine-parity hostname validation:
// plugins/plugin-blocker/src/services/website-blocker/engine.ts runs every
// bare hostname through `new URL(...).hostname` (IDNA ToASCII) and then
// checks each label against [a-z0-9-] with hyphen edges rejected, rejecting
// IP literals. These cases pin the web shim to that contract.
describe("normalizeHostname", () => {
  it("accepts a unicode IDN hostname as its punycode form", () => {
    expect(normalizeHostname("münchen.de")).toBe("xn--mnchen-3ya.de");
  });

  it("accepts a punycode-typed IDN TLD on the same grammar as the unicode spelling", () => {
    // The pre-unification defect: "пример.рф" passed while its ASCII spelling
    // "xn--e1afmkfd.xn--p1ai" was refused by the letters-only TLD rule.
    expect(normalizeHostname("пример.рф")).toBe("xn--e1afmkfd.xn--p1ai");
    expect(normalizeHostname("xn--e1afmkfd.xn--p1ai")).toBe(
      "xn--e1afmkfd.xn--p1ai",
    );
  });

  it("keeps plain ASCII hostnames unchanged", () => {
    expect(normalizeHostname("example.com")).toBe("example.com");
    expect(normalizeHostname("EXAMPLE.COM")).toBe("example.com");
  });

  it("strips a wildcard prefix before validating", () => {
    expect(normalizeHostname("*.example.com")).toBe("example.com");
    expect(normalizeHostname("*.münchen.de")).toBe("xn--mnchen-3ya.de");
  });

  it("parses URL input down to the hostname", () => {
    expect(normalizeHostname("https://münchen.de")).toBe("xn--mnchen-3ya.de");
    expect(normalizeHostname("https://EXAMPLE.COM:8080/path")).toBe(
      "example.com",
    );
  });

  it("strips ports and userinfo like the engine's URL normalization", () => {
    expect(normalizeHostname("example.com:8080")).toBe("example.com");
    expect(normalizeHostname("user@example.com")).toBe("example.com");
  });

  it("rejects IP literals", () => {
    expect(normalizeHostname("1.2.3.4")).toBeNull();
    expect(normalizeHostname("[::1]")).toBeNull();
    // Hex IPv4 is folded to 127.0.0.1 by the URL host parser, then rejected.
    expect(normalizeHostname("0x7f.0x0.0x0.0x1")).toBeNull();
  });

  it("rejects all-numeric TLDs, matching the engine's isIP/domainToASCII behavior", () => {
    expect(normalizeHostname("café.123")).toBeNull();
    expect(normalizeHostname("пример.123")).toBeNull();
  });

  it("rejects non-http(s) schemes and unparseable input", () => {
    expect(normalizeHostname("ftp://example.com")).toBeNull();
    expect(normalizeHostname("not a hostname!!")).toBeNull();
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname(null)).toBeNull();
    expect(normalizeHostname("münchen")).toBeNull();
  });
});

describe("validateStartBlockOptions", () => {
  it("keeps a mixed list of unicode and punycode IDN entries without dropping any", () => {
    // Regression: the old ASCII path silently dropped the punycode spelling
    // of an IDN hostname from a mixed list the engine accepts in full.
    const result = validateStartBlockOptions({
      websites: ["example.com", "пример.рф", "xn--e1afmkfd.xn--p1ai"],
    });
    expect(result.websites).toEqual(["example.com", "xn--e1afmkfd.xn--p1ai"]);
    expect(result.durationMinutes).toBeNull();
  });

  it("throws when every candidate is invalid", () => {
    expect(() =>
      validateStartBlockOptions({ websites: ["1.2.3.4", "not a host"] }),
    ).toThrow("Provide at least one public website hostname.");
  });
});
