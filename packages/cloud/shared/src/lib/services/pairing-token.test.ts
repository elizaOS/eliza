/**
 * Deterministically exercises pairing-token domain aliases without network or storage.
 */
import { describe, expect, it } from "bun:test";
import { DOMAIN_ALIAS_GROUPS, getAlternateDomainOrigins } from "./pairing-token-domains";

const [PRODUCTION_ALIAS_GROUP, STAGING_ALIAS_GROUP] = DOMAIN_ALIAS_GROUPS;

/** Returns the sibling hostnames for a matched alias suffix. */
function aliasHostnames(group: readonly string[], prefix: string, matched: string): string[] {
  return group
    .filter((suffix) => suffix !== matched)
    .map((suffix) => `${prefix}${suffix}`)
    .sort();
}

describe("getAlternateDomainOrigins", () => {
  it("returns every other suffix in the same alias group", () => {
    for (const group of DOMAIN_ALIAS_GROUPS) {
      for (const suffix of group) {
        const origin = `https://abc${suffix}`;
        const alternates = getAlternateDomainOrigins(origin);

        expect(alternates).toHaveLength(group.length - 1);
        expect(alternates).not.toContain(origin);
        expect(alternates.map((alternate) => new URL(alternate).hostname).sort()).toEqual(
          aliasHostnames(group, "abc", suffix),
        );
      }
    }
  });

  it("rewrites the suffix while keeping the agent UUID prefix intact", () => {
    const alts = getAlternateDomainOrigins(
      "https://9d77d8b5-1d63-4b4c-9bd1-ec1b5deb4dc8.waifu.fun",
    );
    const hostnames = alts.map((u) => new URL(u).hostname).sort();
    expect(hostnames).toEqual(
      aliasHostnames(PRODUCTION_ALIAS_GROUP, "9d77d8b5-1d63-4b4c-9bd1-ec1b5deb4dc8", ".waifu.fun"),
    );
  });

  it("uses the most specific suffix when staging and production aliases overlap", () => {
    const origin = "https://agent-7.staging.elizacloud.ai";

    expect(getAlternateDomainOrigins(origin)).toEqual(["https://agent-7.cloud-staging.eliza.app"]);
    expect(getAlternateDomainOrigins(origin)).not.toContain(
      "https://agent-7.staging.cloud.eliza.app",
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
    expect(alts).toHaveLength(PRODUCTION_ALIAS_GROUP.length - 1);
    for (const alt of alts) {
      const url = new URL(alt);
      expect(url.port).toBe("8443");
    }
  });

  it("rejects nested prefixes that are not flat managed-agent hosts", () => {
    expect(getAlternateDomainOrigins("https://a.b.c.waifu.fun")).toEqual([]);
    expect(getAlternateDomainOrigins("https://agent-7.staging.cloud.eliza.app")).toEqual([]);
  });

  it("rejects prefixes that are not valid managed-agent DNS labels", () => {
    expect(getAlternateDomainOrigins("https://-agent.waifu.fun")).toEqual([]);
    expect(getAlternateDomainOrigins("https://agent-.waifu.fun")).toEqual([]);
    expect(getAlternateDomainOrigins(`https://${"a".repeat(64)}.waifu.fun`)).toEqual([]);
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
    expect(hostnames).toEqual(aliasHostnames(PRODUCTION_ALIAS_GROUP, "abc", ".waifu.fun"));
  });

  it("matches the suffix on the right boundary (no partial-domain false positive)", () => {
    // `notwaifu.fun` contains the literal text `waifu.fun` but does not end
    // with `.waifu.fun`, so it must not alias into the group.
    expect(getAlternateDomainOrigins("https://abc.notwaifu.fun")).toEqual([]);
    expect(getAlternateDomainOrigins("https://abceliza.ai")).toEqual([]);
  });
});

describe("DOMAIN_ALIAS_GROUPS", () => {
  it("retains every canonical and compatibility suffix", () => {
    expect(PRODUCTION_ALIAS_GROUP).toEqual(
      expect.arrayContaining([".cloud.eliza.app", ".elizacloud.ai", ".waifu.fun", ".eliza.ai"]),
    );
    expect(STAGING_ALIAS_GROUP).toEqual(
      expect.arrayContaining([".cloud-staging.eliza.app", ".staging.elizacloud.ai"]),
    );
  });

  it("uses leading-dot suffixes so subdomain matching is anchored", () => {
    for (const group of DOMAIN_ALIAS_GROUPS) {
      for (const suffix of group) {
        expect(suffix.startsWith(".")).toBe(true);
      }
    }
  });
});
