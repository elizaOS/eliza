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
    // These inputs never reach the label grammar: a numeric final label
    // routes the host into IPv4 parsing and the URL parser throws, on both
    // sides. The grammar's letter lookahead is pinned separately below.
    expect(normalizeHostname("café.123")).toBeNull();
    expect(normalizeHostname("пример.123")).toBeNull();
  });

  it("accepts a scheme:user@host input as the host, matching the engine's verdict", () => {
    // The scheme guard above requires "://", so "mailto:..." falls through
    // to the bare-host path and the URL parser reads "someone" as userinfo.
    // Pinned against the engine's verdict by execution (2026-10-20):
    // engine.ts normalizeWebsiteTarget returns the same "example.com" — its
    // scheme test also requires "://" and it prepends "https://" the same
    // way — so this is engine parity, not a shim-only acceptance.
    expect(normalizeHostname("mailto:someone@example.com")).toBe("example.com");
    expect(normalizeHostname("example.com/path")).toBe("example.com");
  });

  it("rejects a digit-and-hyphen-only TLD through the letter lookahead", () => {
    // Unlike café.123, "123-456" is not an IPv4 shape, so this input reaches
    // ENGINE_PARITY_HOSTNAME_RE and only the final-label letter lookahead
    // rejects it. Mutation-verified (2026-10-20): deleting the lookahead
    // turns this case red while the all-numeric-TLD cases above stay green.
    // The engine accepts this shape (its isIP check passes); the shim stays
    // stricter because a digit/hyphen-only final label is not a public TLD
    // and browser code has no node:net isIP to draw the line with.
    expect(normalizeHostname("example.123-456")).toBeNull();
  });

  it("rejects non-http(s) schemes and unparseable input", () => {
    expect(normalizeHostname("ftp://example.com")).toBeNull();
    expect(normalizeHostname("not a hostname!!")).toBeNull();
    expect(normalizeHostname("")).toBeNull();
    expect(normalizeHostname(null)).toBeNull();
    expect(normalizeHostname("münchen")).toBeNull();
  });
});

describe("engine parity fixture", () => {
  // Expected values recorded on 2026-10-20 by executing the server engine —
  // normalizeWebsiteTargets in
  // plugins/plugin-blocker/src/services/website-blocker/engine.ts — over
  // this corpus under bun. Parity for these inputs is pinned by this
  // fixture, not by comments in web.ts. Inputs where the shim is
  // deliberately different are covered by their own cases above and are
  // excluded here: wildcard stripping ("*.example.com"), non-http(s)
  // scheme rejection ("ftp://example.com"), and ".local" acceptance.
  const fixture: Array<[string, string | null]> = [
    ["mailto:someone@example.com", "example.com"],
    ["example.com/path", "example.com"],
    ["https://EXAMPLE.COM:8080/path", "example.com"],
    ["münchen.de", "xn--mnchen-3ya.de"],
    ["пример.рф", "xn--e1afmkfd.xn--p1ai"],
    ["xn--e1afmkfd.xn--p1ai", "xn--e1afmkfd.xn--p1ai"],
    ["example.com", "example.com"],
    ["EXAMPLE.COM", "example.com"],
    ["example.com:8080", "example.com"],
    ["user@example.com", "example.com"],
    ["example.1a", "example.1a"],
    ["café.123", null],
    ["пример.123", null],
    ["example.123", null],
    ["1.2.3.4", null],
    ["0x7f.0x0.0x0.0x1", null],
    ["[::1]", null],
    ["localhost", null],
    ["münchen", null],
    ["not a hostname!!", null],
  ];

  it("matches the engine's recorded verdict on every fixture input", () => {
    for (const [input, expected] of fixture) {
      expect(normalizeHostname(input), input).toBe(expected);
    }
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
