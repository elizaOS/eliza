// Exercises pairing token behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "bun:test";
import { DOMAIN_ALIAS_GROUPS, getAlternateDomainOrigins } from "./pairing-token-domains";

describe("getAlternateDomainOrigins", () => {
  it("returns every other suffix in the same alias group", () => {
    // The canonical group is the first entry. Verify each domain produces
    // (group.length - 1) alternates — the matched suffix is excluded.
    const inputs = ["https://abc.waifu.fun", "https://abc.eliza.ai", "https://abc.elizacloud.ai"];

    for (const origin of inputs) {
      const alts = getAlternateDomainOrigins(origin);
      expect(alts).toHaveLength(2);
      expect(alts).not.toContain(origin);
      const hostnames = alts.map((url) => new URL(url).hostname);
      for (const hostname of hostnames) {
        expect(hostname.startsWith("abc.")).toBe(true);
      }
    }
  });

  it("rewrites the suffix while keeping the agent UUID prefix intact", () => {
    const alts = getAlternateDomainOrigins(
      "https://9d77d8b5-1d63-4b4c-9bd1-ec1b5deb4dc8.waifu.fun",
    );
    const hostnames = alts.map((u) => new URL(u).hostname).sort();
    expect(hostnames).toEqual(
      [
        "9d77d8b5-1d63-4b4c-9bd1-ec1b5deb4dc8.eliza.ai",
        "9d77d8b5-1d63-4b4c-9bd1-ec1b5deb4dc8.elizacloud.ai",
      ].sort(),
    );
  });

  it("rejects retired 0xSolace-era domains (example.ai, shad0w.xyz)", () => {
    // These domains were intentionally dropped from the alias group to
    // close the zero-compatibility-domain goal. A leftover bookmark must fail Origin
    // validation rather than silently aliasing into a live brand.
    expect(getAlternateDomainOrigins("https://abc.example.ai")).toEqual([]);
    expect(getAlternateDomainOrigins("https://abc.shad0w.xyz")).toEqual([]);
  });

  it("preserves the URL port when an origin includes one", () => {
    // `URL.origin` keeps non-default ports — the alternate origins must
    // round-trip them so a sandbox served on :8443 still matches its alias.
    const alts = getAlternateDomainOrigins("https://abc.waifu.fun:8443");
    expect(alts).toHaveLength(2);
    for (const alt of alts) {
      const url = new URL(alt);
      expect(url.port).toBe("8443");
    }
  });

  it("rewrites only the suffix when the prefix is itself a multi-level subdomain", () => {
    // Production sandbox URLs are flat (`<uuid>.waifu.fun`), but the
    // suffix-strip algorithm should treat anything before the matched
    // suffix as opaque prefix — so `a.b.c.waifu.fun` aliases to
    // `a.b.c.eliza.ai` without touching the inner labels.
    const alts = getAlternateDomainOrigins("https://a.b.c.waifu.fun");
    const hostnames = alts.map((u) => new URL(u).hostname).sort();
    expect(hostnames).toEqual(["a.b.c.eliza.ai", "a.b.c.elizacloud.ai"].sort());
  });

  it("returns an empty array when no aliased suffix matches", () => {
    expect(getAlternateDomainOrigins("https://example.com")).toEqual([]);
    expect(getAlternateDomainOrigins("https://app.elizacloud.io")).toEqual([]);
    expect(getAlternateDomainOrigins("https://waifu.fun.evil.tld")).toEqual([]);
  });

  it("returns an empty array for unparseable input rather than throwing", () => {
    expect(getAlternateDomainOrigins("not a url")).toEqual([]);
    expect(getAlternateDomainOrigins("")).toEqual([]);
    expect(getAlternateDomainOrigins("://no-protocol")).toEqual([]);
  });

  it("matches uppercase hostnames (URL parser lowercases per WHATWG spec)", () => {
    // `endsWith` is case-sensitive but `new URL()` lowercases the hostname,
    // so an Origin header arriving as `https://ABC.WAIFU.FUN` still aliases.
    const alts = getAlternateDomainOrigins("https://ABC.WAIFU.FUN");
    const hostnames = alts.map((u) => new URL(u).hostname).sort();
    expect(hostnames).toEqual(["abc.eliza.ai", "abc.elizacloud.ai"].sort());
  });

  it("matches the suffix on the right boundary (no partial-domain false positive)", () => {
    // `notwaifu.fun` contains the literal text `waifu.fun` but does not end
    // with `.waifu.fun`, so it must not alias into the group.
    expect(getAlternateDomainOrigins("https://abc.notwaifu.fun")).toEqual([]);
    expect(getAlternateDomainOrigins("https://abceliza.ai")).toEqual([]);
  });
});

describe("DOMAIN_ALIAS_GROUPS", () => {
  it("declares the rebrand-target domain `.elizacloud.ai` so the suffix matches", () => {
    // This is the load-bearing guarantee for the rebrand: pairing tokens
    // issued against `.waifu.fun` must validate when the dashboard rewrites
    // the agent URL to `.elizacloud.ai`. If someone removes elizacloud.ai
    // from the group, this test fails loudly.
    const allDomains = DOMAIN_ALIAS_GROUPS.flat();
    expect(allDomains).toContain(".elizacloud.ai");
    expect(allDomains).toContain(".waifu.fun");
  });

  it("uses leading-dot suffixes so subdomain matching is anchored", () => {
    for (const group of DOMAIN_ALIAS_GROUPS) {
      for (const suffix of group) {
        expect(suffix.startsWith(".")).toBe(true);
      }
    }
  });
});
