import { describe, expect, it } from "bun:test";
import { DOMAIN_ALIAS_GROUPS, getAlternateDomainOrigins } from "./pairing-token-domains";

describe("getAlternateDomainOrigins", () => {
  it("returns every other suffix in the same alias group", () => {
    // The canonical group is the first entry. Verify all five domains
    // produce four alternates each (the matched suffix is excluded).
    const inputs = [
      "https://abc.waifu.fun",
      "https://abc.eliza.ai",
      "https://abc.elizacloud.ai",
      "https://abc.milady.ai",
      "https://abc.shad0w.xyz",
    ];

    for (const origin of inputs) {
      const alts = getAlternateDomainOrigins(origin);
      expect(alts).toHaveLength(4);
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
        "9d77d8b5-1d63-4b4c-9bd1-ec1b5deb4dc8.milady.ai",
        "9d77d8b5-1d63-4b4c-9bd1-ec1b5deb4dc8.shad0w.xyz",
      ].sort(),
    );
  });

  it("preserves the URL port when an origin includes one", () => {
    // `URL.origin` keeps non-default ports — the alternate origins must
    // round-trip them so a sandbox served on :8443 still matches its alias.
    const alts = getAlternateDomainOrigins("https://abc.waifu.fun:8443");
    expect(alts.length).toBeGreaterThan(0);
    for (const alt of alts) {
      const url = new URL(alt);
      expect(url.port).toBe("8443");
    }
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
