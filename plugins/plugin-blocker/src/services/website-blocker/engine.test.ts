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
