import { describe, expect, it } from "vitest";
import { getDefaultAutofillWhitelist } from "./autofill-whitelist-pack.ts";

describe("getDefaultAutofillWhitelist", () => {
  it("returns a non-empty list of brand domains", () => {
    const domains = getDefaultAutofillWhitelist();
    expect(domains.length).toBeGreaterThan(10);
    expect(domains).toContain("github.com");
    expect(domains).toContain("google.com");
  });

  it("excludes unsafe or consumer-credential domains", () => {
    const domains = getDefaultAutofillWhitelist().join(",");
    // 白名单不应包含高风险/未知域
    for (const unsafe of ["example.com", "pastebin.com", "0.0.0.0"]) {
      expect(domains).not.toContain(unsafe);
    }
  });

  it("contains no empty or malformed entries", () => {
    const domains = getDefaultAutofillWhitelist();
    for (const d of domains) {
      expect(d.length).toBeGreaterThan(3);
      expect(d).not.toContain(" ");
      expect(d).not.toMatch(/^https?:\/\//);
    }
  });

  it("contains only lowercase domain names", () => {
    const domains = getDefaultAutofillWhitelist();
    for (const d of domains) {
      expect(d).toBe(d.toLowerCase());
    }
  });
});
