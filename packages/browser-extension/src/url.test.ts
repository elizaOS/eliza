/**
 * Unit tests for the URL normalization helpers, including rejection of unsafe
 * URL forms (credentials, non-http schemes).
 */
import { describe, expect, it } from "vitest";
import { normalizeHttpBaseUrl, normalizeHttpOrigin } from "./url";

describe("normalizeHttpBaseUrl", () => {
  it("normalizes http URLs by trimming, stripping query/fragment, and removing trailing slashes", () => {
    expect(
      normalizeHttpBaseUrl(" https://agent.example.com/api///?debug=1#top "),
    ).toBe("https://agent.example.com/api");
  });

  it("uses the provided default for blank input and rejects unsafe URL forms", () => {
    expect(normalizeHttpBaseUrl("   ", "http://127.0.0.1:31337")).toBe(
      "http://127.0.0.1:31337",
    );
    for (const value of [
      "javascript:alert(1)",
      "file:///tmp/socket",
      "https://user:pass@agent.example.com",
      "not a url",
    ]) {
      expect(normalizeHttpBaseUrl(value)).toBeNull();
    }
  });
});

describe("normalizeHttpOrigin", () => {
  it("keeps only the safe origin for http URLs", () => {
    expect(normalizeHttpOrigin("http://localhost:2138/path?debug=1#top")).toBe(
      "http://localhost:2138",
    );
    expect(normalizeHttpOrigin("https://agent.example.com/app")).toBe(
      "https://agent.example.com",
    );
  });

  it("rejects missing, credentialed, non-http, and malformed origins", () => {
    for (const value of [
      null,
      undefined,
      "ftp://agent.example.com",
      "https://user:pass@agent.example.com",
      "not a url",
    ]) {
      expect(normalizeHttpOrigin(value)).toBeNull();
    }
  });
});
