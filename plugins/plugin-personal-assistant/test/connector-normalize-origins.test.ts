// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  normalizeBrowserPermissionGrant,
  normalizeBrowserPermissionGrantList,
  normalizeOrigin,
  normalizeOriginList,
} from "../src/lifeops/service-normalize-connector.js";

/**
 * Browser-permission origin normalization is the input boundary for what a
 * connector may touch (#8795). It must reduce URLs to bare origins, reject
 * non-http(s) schemes, accept extension host-permission patterns verbatim, and
 * de-duplicate — never widen a grant by silently coercing a bad value.
 */

describe("normalizeOrigin", () => {
  it("reduces a URL to its origin", () => {
    expect(normalizeOrigin("https://example.com/a/b?x=1", "o")).toBe(
      "https://example.com",
    );
    expect(normalizeOrigin("http://foo.com:8080/x", "o")).toBe(
      "http://foo.com:8080",
    );
  });

  it("rejects non-http(s) schemes and malformed input", () => {
    expect(() => normalizeOrigin("ftp://x.com", "o")).toThrow();
    expect(() => normalizeOrigin("not a url", "o")).toThrow();
    expect(() => normalizeOrigin("", "o")).toThrow();
  });
});

describe("normalizeBrowserPermissionGrant", () => {
  it("passes through <all_urls> and wildcard host-permission patterns", () => {
    expect(normalizeBrowserPermissionGrant("<all_urls>", "g")).toBe(
      "<all_urls>",
    );
    expect(
      normalizeBrowserPermissionGrant("https://*.example.com/*", "g"),
    ).toBe("https://*.example.com/*");
    expect(normalizeBrowserPermissionGrant("file:///Users/x", "g")).toBe(
      "file:///Users/x",
    );
  });

  it("normalizes a concrete https grant to its origin", () => {
    expect(normalizeBrowserPermissionGrant("https://site.com/page", "g")).toBe(
      "https://site.com",
    );
  });

  it("rejects a value that is neither origin nor host-permission pattern", () => {
    expect(() => normalizeBrowserPermissionGrant("justtext", "g")).toThrow();
  });
});

describe("list normalizers", () => {
  it("normalize + de-duplicate a grant list", () => {
    expect(
      normalizeBrowserPermissionGrantList(
        ["https://a.com/x", "https://a.com/y", "<all_urls>"],
        "g",
      ),
    ).toEqual(["<all_urls>", "https://a.com"]);
    expect(() => normalizeBrowserPermissionGrantList("nope", "g")).toThrow();
  });

  it("normalize + de-duplicate an origin list", () => {
    expect(
      normalizeOriginList(["https://a.com/1", "https://a.com/2"], "o"),
    ).toEqual(["https://a.com"]);
    expect(() => normalizeOriginList({}, "o")).toThrow();
  });
});
