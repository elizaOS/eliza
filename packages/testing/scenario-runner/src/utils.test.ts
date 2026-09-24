/**
 * Tests for the loopback-URL check (#8801 / #9943). isLoopbackUrl decides
 * whether a URL points at the local machine — a trust/SSRF-relevant gate.
 * Notably the AWS-metadata and private-but-not-loopback hosts must read as
 * NON-loopback.
 */
import { describe, expect, it } from "vitest";
import { isLoopbackUrl } from "./utils";

describe("isLoopbackUrl", () => {
  it("recognizes loopback hosts (v4, localhost, v6, bracketed v6)", () => {
    for (const u of [
      "http://127.0.0.1:31337",
      "http://localhost/x",
      "https://localhost",
      "http://[::1]:8080",
    ]) {
      expect(isLoopbackUrl(u)).toBe(true);
    }
  });

  it("treats remote, private-non-loopback, and metadata hosts as non-loopback", () => {
    for (const u of [
      "http://evil.com",
      "https://example.org/api",
      "http://10.0.0.5",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata endpoint
    ]) {
      expect(isLoopbackUrl(u)).toBe(false);
    }
  });

  it("returns false for undefined, empty, or unparseable input", () => {
    expect(isLoopbackUrl(undefined)).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
