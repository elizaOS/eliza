import { describe, expect, it } from "vitest";
import { assertHttpHttpsUrl } from "../safe-url.js";

describe("assertHttpHttpsUrl (GHSA-w846-hghr-xmrc)", () => {
  it("accepts http and https URLs", () => {
    expect(assertHttpHttpsUrl("https://example.com").href).toBe(
      "https://example.com/",
    );
    expect(assertHttpHttpsUrl(" http://example.com/path?q=1 ").href).toBe(
      "http://example.com/path?q=1",
    );
  });

  it("rejects file paths and non-http protocols", () => {
    expect(() => assertHttpHttpsUrl("/etc/passwd")).toThrow("Invalid URL");
    expect(() => assertHttpHttpsUrl("file:///etc/passwd")).toThrow(
      "Invalid protocol",
    );
    expect(() => assertHttpHttpsUrl("ftp://example.com/file")).toThrow(
      "Invalid protocol",
    );
  });

  it("rejects obvious local and private-network SSRF targets", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "http://api.localhost:3000",
      "http://10.0.0.5",
      "http://172.16.0.5",
      "http://172.31.255.255",
      "http://192.168.1.10",
      "http://2130706433",
      "http://0x7f000001",
      "http://0177.0.0.1",
      "http://0300.0250.0001.0012",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
    ]) {
      expect(() => assertHttpHttpsUrl(url)).toThrow("Invalid host");
    }
  });
});
