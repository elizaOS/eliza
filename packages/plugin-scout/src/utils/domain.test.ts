import { describe, it, expect } from "vitest";
import { extractDomain, extractDomains } from "./domain.js";

describe("extractDomain", () => {
  it("extracts a bare domain", () => {
    expect(extractDomain("check questflow.ai please")).toBe("questflow.ai");
  });

  it("extracts domain from https URL", () => {
    expect(extractDomain("visit https://api.example.com/v1")).toBe("api.example.com");
  });

  it("extracts domain from http URL", () => {
    expect(extractDomain("go to http://test.service.io")).toBe("test.service.io");
  });

  it("strips port, path, and query string", () => {
    expect(extractDomain("https://api.example.com:8443/v1/score?key=abc")).toBe("api.example.com");
  });

  it("returns null for no domain", () => {
    expect(extractDomain("hello world")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractDomain("")).toBeNull();
  });

  it("does not match IP addresses", () => {
    expect(extractDomain("connect to 192.168.1.1")).toBeNull();
  });

  it("does not match localhost", () => {
    expect(extractDomain("running on localhost:3000")).toBeNull();
  });

  it("extracts the first domain when multiple exist", () => {
    expect(extractDomain("compare foo.com and bar.io")).toBe("foo.com");
  });

  it("handles subdomains", () => {
    expect(extractDomain("api.v2.service.example.com")).toBe("api.v2.service.example.com");
  });

  it("truncates input over 2000 chars", () => {
    const padding = "a".repeat(2001);
    const text = padding + " questflow.ai";
    // Domain is past the 2000-char limit, should not be found
    expect(extractDomain(text)).toBeNull();
  });

  it("finds domain within 2000-char limit", () => {
    const padding = "a".repeat(1980);
    const text = "questflow.ai " + padding;
    expect(extractDomain(text)).toBe("questflow.ai");
  });

  it("handles hyphens in domain labels", () => {
    expect(extractDomain("my-service.example.com")).toBe("my-service.example.com");
  });

  it("does not match single-label names", () => {
    // No TLD
    expect(extractDomain("just myservice")).toBeNull();
  });
});

describe("extractDomains", () => {
  it("extracts multiple unique domains", () => {
    const result = extractDomains("compare foo.com, bar.io, and baz.org");
    expect(result).toEqual(["foo.com", "bar.io", "baz.org"]);
  });

  it("deduplicates repeated domains", () => {
    const result = extractDomains("foo.com is better than foo.com");
    expect(result).toEqual(["foo.com"]);
  });

  it("returns empty array for no domains", () => {
    expect(extractDomains("no domains here")).toEqual([]);
  });

  it("handles URLs mixed with bare domains", () => {
    const result = extractDomains("visit https://api.example.com and check bar.io");
    expect(result).toEqual(["api.example.com", "bar.io"]);
  });

  it("truncates input over 2000 chars", () => {
    const padding = "a".repeat(2001);
    expect(extractDomains(padding + " foo.com")).toEqual([]);
  });
});