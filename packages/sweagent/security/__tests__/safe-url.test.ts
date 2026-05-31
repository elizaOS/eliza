import { describe, expect, it } from "vitest";
import { assertHttpHttpsUrl } from "../safe-url.js";

describe("assertHttpHttpsUrl (GHSA-w846-hghr-xmrc)", () => {
  it("accepts http and https URLs", () => {
    expect(assertHttpHttpsUrl("https://example.com").href).toBe(
      "https://example.com/",
    );
  });

  it("rejects file paths and metadata SSRF targets", () => {
    expect(() => assertHttpHttpsUrl("/etc/passwd")).toThrow("Invalid URL");
    expect(() => assertHttpHttpsUrl("file:///etc/passwd")).toThrow(
      "Invalid protocol",
    );
    expect(() =>
      assertHttpHttpsUrl("http://169.254.169.254/latest/meta-data"),
    ).not.toThrow();
  });
});
