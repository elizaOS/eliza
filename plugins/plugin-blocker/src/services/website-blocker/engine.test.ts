import { describe, expect, it } from "vitest";
import {
  buildSelfControlBlockPolicy,
  isWebsiteBlockedByPolicy,
  isWebsiteBlockSinkholeAddress,
  normalizeWebsiteTargets,
  parseResolvedAddressesFromDscacheutilOutput,
} from "./engine.ts";

/**
 * First tests for the website-blocker decision engine (#8801 / #9943 —
 * plugin-blocker shipped with zero tests). This is the security-relevant core:
 * whether a given site is blocked under a self-control policy. Reserved test
 * domains (example.com/.org/.net) are used so the assertions don't depend on the
 * built-in policy groups for real sites.
 */
describe("website-blocker engine", () => {
  describe("buildSelfControlBlockPolicy", () => {
    it("blocks the requested host and its www variant (2-label hosts)", () => {
      const policy = buildSelfControlBlockPolicy(["example.com"]);
      expect(policy.blockedWebsites).toContain("example.com");
      expect(policy.blockedWebsites).toContain("www.example.com");
      expect(policy.matchMode).toBe("exact");
    });

    it("normalizes URLs + casing to bare hosts and dedups", () => {
      const policy = buildSelfControlBlockPolicy([
        "HTTPS://Example.COM/some/path",
        "example.com",
      ]);
      expect(policy.requestedWebsites).toEqual(["example.com"]);
    });

    it("does not add a www variant for a host that already has a subdomain", () => {
      const policy = buildSelfControlBlockPolicy(["sub.example.org"]);
      expect(policy.blockedWebsites).toContain("sub.example.org");
      expect(policy.blockedWebsites).not.toContain("www.sub.example.org");
    });

    it("adds the www variant for a country-code second-level registrable domain", () => {
      // `bbc.co.uk`-style sites redirect the bare host to `www.`, so blocking
      // only the bare host leaves the site reachable.
      const policy = buildSelfControlBlockPolicy([
        "example.co.uk",
        "example.com.au",
      ]);
      expect(policy.blockedWebsites).toContain("www.example.co.uk");
      expect(policy.blockedWebsites).toContain("www.example.com.au");
      expect(
        isWebsiteBlockedByPolicy(policy, "https://www.example.co.uk/news"),
      ).toBe(true);
    });

    it("still treats a subdomain under a country-code SLD as a subdomain", () => {
      const policy = buildSelfControlBlockPolicy(["news.example.co.uk"]);
      expect(policy.blockedWebsites).toEqual(["news.example.co.uk"]);
    });

    it("blocks the bare domain when the request names its www host", () => {
      const policy = buildSelfControlBlockPolicy(["https://www.example.com/"]);
      expect(policy.requestedWebsites).toEqual(["www.example.com"]);
      expect(policy.blockedWebsites).toContain("www.example.com");
      expect(policy.blockedWebsites).toContain("example.com");
      expect(isWebsiteBlockedByPolicy(policy, "example.com")).toBe(true);
    });

    it("applies a site's policy group when the request names its www host", () => {
      const policy = buildSelfControlBlockPolicy(["www.twitter.com"]);
      // twitter.com redirects to x.com; the group must apply as it does for
      // a bare `twitter.com` request.
      expect([...policy.blockedWebsites].sort()).toEqual(
        [
          ...buildSelfControlBlockPolicy(["twitter.com"]).blockedWebsites,
        ].sort(),
      );
      expect(isWebsiteBlockedByPolicy(policy, "x.com")).toBe(true);
      expect(isWebsiteBlockedByPolicy(policy, "api.twitter.com")).toBe(false);
    });
  });

  describe("public-suffix policy boundaries", () => {
    it("preserves a subdomain whose labels resemble a country-code suffix", () => {
      expect(
        buildSelfControlBlockPolicy(["news.co.fr"]).blockedWebsites,
      ).toEqual(["news.co.fr"]);
    });
    it("keeps a registrable domain named www instead of stripping its label", () => {
      expect(
        buildSelfControlBlockPolicy(["www.co.uk"]).blockedWebsites.toSorted(),
      ).toEqual(["www.co.uk", "www.www.co.uk"]);
      expect(
        buildSelfControlBlockPolicy([
          "www.www.co.uk",
        ]).blockedWebsites.toSorted(),
      ).toEqual(["www.co.uk", "www.www.co.uk"]);
    });
    it("recognizes a registrable country-code domain outside the former label list", () => {
      expect(
        buildSelfControlBlockPolicy([
          "www.shop.firm.in",
        ]).blockedWebsites.toSorted(),
      ).toEqual(["shop.firm.in", "www.shop.firm.in"]);
    });
  });

  describe("normalizeWebsiteTargets", () => {
    it("strips scheme/path/case and drops invalid targets", () => {
      const out = normalizeWebsiteTargets([
        "https://Example.com/abc",
        "example.com",
        "localhost", // dropped (no public TLD)
        "1.2.3.4", // dropped (bare IP)
      ]);
      expect(out).toEqual(["example.com"]);
    });
  });

  describe("isWebsiteBlockedByPolicy", () => {
    const policy = buildSelfControlBlockPolicy(["example.com"]);

    it("blocks the exact host and its www variant", () => {
      expect(isWebsiteBlockedByPolicy(policy, "example.com")).toBe(true);
      expect(isWebsiteBlockedByPolicy(policy, "www.example.com")).toBe(true);
    });

    it("allows an unrelated host", () => {
      expect(isWebsiteBlockedByPolicy(policy, "example.org")).toBe(false);
    });

    it("normalizes the query (URL + case) before matching", () => {
      expect(isWebsiteBlockedByPolicy(policy, "https://EXAMPLE.com/feed")).toBe(
        true,
      );
    });

    it("exact match mode does NOT block subdomains; subdomain mode does", () => {
      const exact = {
        blockedWebsites: ["example.com"],
        allowedWebsites: [],
        matchMode: "exact" as const,
      };
      const subdomain = { ...exact, matchMode: "subdomain" as const };
      expect(isWebsiteBlockedByPolicy(exact, "deep.example.com")).toBe(false);
      expect(isWebsiteBlockedByPolicy(subdomain, "deep.example.com")).toBe(
        true,
      );
    });

    it("allow-list wins over the block-list", () => {
      const both = {
        blockedWebsites: ["example.com"],
        allowedWebsites: ["example.com"],
        matchMode: "exact" as const,
      };
      expect(isWebsiteBlockedByPolicy(both, "example.com")).toBe(false);
    });

    it("returns false for an unparseable / non-public query", () => {
      expect(isWebsiteBlockedByPolicy(policy, "localhost")).toBe(false);
    });
  });

  describe("isWebsiteBlockSinkholeAddress", () => {
    it("detects loopback / null-route sinkholes", () => {
      for (const a of [
        "0.0.0.0",
        "127.0.0.1",
        "127.5.5.5",
        "::1",
        "  0.0.0.0  ",
      ]) {
        expect(isWebsiteBlockSinkholeAddress(a)).toBe(true);
      }
    });
    it("treats real public resolvers as non-sinkhole", () => {
      for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
        expect(isWebsiteBlockSinkholeAddress(a)).toBe(false);
      }
    });
  });

  describe("parseResolvedAddressesFromDscacheutilOutput", () => {
    it("extracts ip/ipv6 addresses and dedups", () => {
      const out = parseResolvedAddressesFromDscacheutilOutput(
        [
          "name: example.com",
          "ip_address: 1.2.3.4",
          "ip_address: 1.2.3.4",
          "ipv6_address: ::1",
        ].join("\n"),
      );
      expect(out).toEqual(["1.2.3.4", "::1"]);
    });
  });
});
