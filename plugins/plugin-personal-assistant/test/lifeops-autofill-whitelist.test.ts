// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  extractRegistrableDomain,
  isUrlWhitelisted,
  normalizeAutofillDomain,
} from "../src/lifeops/autofill-whitelist.js";

/**
 * The autofill whitelist is the agent-side gate that decides whether a
 * credential may be filled on a given URL — a security boundary, so its
 * domain-matching must reject prefix/suffix spoofing, IPs, and localhost.
 */

describe("extractRegistrableDomain", () => {
  it("extracts the registrable domain from URLs and bare hosts", () => {
    expect(extractRegistrableDomain("https://login.example.com/path")).toBe(
      "example.com",
    );
    expect(extractRegistrableDomain("example.com")).toBe("example.com");
    expect(extractRegistrableDomain("EXAMPLE.COM")).toBe("example.com");
    expect(extractRegistrableDomain("example.com.")).toBe("example.com");
    expect(extractRegistrableDomain("//example.com/x")).toBe("example.com");
  });

  it("rejects non-routable / non-registrable inputs", () => {
    expect(extractRegistrableDomain("")).toBeNull();
    expect(extractRegistrableDomain("   ")).toBeNull();
    expect(extractRegistrableDomain("localhost")).toBeNull();
    expect(extractRegistrableDomain("127.0.0.1")).toBeNull();
    expect(extractRegistrableDomain("http://127.0.0.1:8080")).toBeNull();
    expect(extractRegistrableDomain("[::1]")).toBeNull();
    expect(extractRegistrableDomain("single")).toBeNull();
    expect(extractRegistrableDomain("not a url")).toBeNull();
    expect(extractRegistrableDomain(123 as unknown as string)).toBeNull();
    expect(extractRegistrableDomain("ftp://bad url with spaces")).toBeNull();
  });

  it("normalizeAutofillDomain is an alias", () => {
    expect(normalizeAutofillDomain("https://x.example.com")).toBe(
      "example.com",
    );
    expect(normalizeAutofillDomain("localhost")).toBeNull();
  });
});

describe("isUrlWhitelisted", () => {
  const wl = ["example.com", "my-bank.com"];

  it("allows an exact registrable-domain match", () => {
    const r = isUrlWhitelisted("https://example.com/login", wl);
    expect(r.allowed).toBe(true);
    expect(r.matched).toBe("example.com");
    expect(r.registrableDomain).toBe("example.com");
  });

  it("allows a subdomain of a whitelisted domain", () => {
    expect(isUrlWhitelisted("https://login.example.com/", wl).allowed).toBe(
      true,
    );
    expect(isUrlWhitelisted("https://a.b.example.com/", wl).allowed).toBe(true);
  });

  it("denies a domain that is not whitelisted", () => {
    const r = isUrlWhitelisted("https://other.com/", wl);
    expect(r.allowed).toBe(false);
    expect(r.matched).toBeNull();
    expect(r.registrableDomain).toBe("other.com");
  });

  it("denies prefix-spoofing (evil-example.com vs example.com)", () => {
    expect(isUrlWhitelisted("https://evil-example.com/", wl).allowed).toBe(
      false,
    );
    expect(isUrlWhitelisted("https://notexample.com/", wl).allowed).toBe(false);
  });

  it("denies suffix-spoofing (example.com.attacker.com)", () => {
    const r = isUrlWhitelisted("https://example.com.attacker.com/", wl);
    expect(r.allowed).toBe(false);
    // The registrable domain is the attacker's, never the whitelisted one.
    expect(r.registrableDomain).toBe("attacker.com");
  });

  it("denies localhost / IP targets even if a similar name is whitelisted", () => {
    expect(isUrlWhitelisted("http://localhost/", wl).allowed).toBe(false);
    expect(isUrlWhitelisted("http://127.0.0.1/", wl).allowed).toBe(false);
    expect(isUrlWhitelisted("", wl).allowed).toBe(false);
  });

  it("matches case-insensitively and ignores empty whitelist entries", () => {
    expect(isUrlWhitelisted("https://LOGIN.EXAMPLE.COM/", wl).allowed).toBe(
      true,
    );
    expect(
      isUrlWhitelisted("https://example.com/", ["", "  ", "example.com"])
        .allowed,
    ).toBe(true);
  });

  it("denies everything against an empty whitelist", () => {
    expect(isUrlWhitelisted("https://example.com/", []).allowed).toBe(false);
  });
});
