import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateCloudBaseUrl } from "../src/cloud/validate-url.js";

/**
 * validateCloudBaseUrl gates the configurable cloud base URL against SSRF: it
 * must require HTTPS, reject local hostnames, and block private/link-local/
 * metadata addresses (incl. IPv4-mapped IPv6). IP-literal hosts are classified
 * without a network round-trip, so these cases are deterministic offline.
 */

let savedNodeEnv: string | undefined;
let savedDev: string | undefined;
beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  savedDev = process.env.ELIZA_DEV;
  // Ensure the IP-range blocking path is active (not the dev-mode bypass).
  process.env.NODE_ENV = "production";
  delete process.env.ELIZA_DEV;
});
afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedDev === undefined) delete process.env.ELIZA_DEV;
  else process.env.ELIZA_DEV = savedDev;
});

describe("validateCloudBaseUrl — format", () => {
  it("rejects an unparseable URL and a non-HTTPS scheme", async () => {
    expect(await validateCloudBaseUrl("not a url")).toMatch(/Invalid cloud base URL/);
    expect(await validateCloudBaseUrl("http://example.com")).toMatch(/must use HTTPS/);
  });
});

describe("validateCloudBaseUrl — local hostnames", () => {
  it("blocks localhost, *.localhost, and *.local", async () => {
    for (const url of ["https://localhost/", "https://api.localhost/", "https://printer.local/"]) {
      expect(await validateCloudBaseUrl(url)).toMatch(/blocked local hostname/);
    }
  });
});

describe("validateCloudBaseUrl — blocked IP literals", () => {
  it("blocks private, loopback, link-local/metadata, and mapped IPv6", async () => {
    for (const url of [
      "https://10.0.0.1/",
      "https://172.16.5.5/",
      "https://192.168.1.1/",
      "https://100.64.0.1/", // CGNAT
      "https://127.0.0.1/",
      "https://169.254.169.254/", // cloud metadata
      "https://[::1]/",
      "https://[fd00::1]/", // ULA
      "https://[::ffff:10.0.0.1]/", // IPv4-mapped private
    ]) {
      expect(await validateCloudBaseUrl(url)).toMatch(/blocked address/);
    }
  });
});

describe("validateCloudBaseUrl — allowed", () => {
  it("passes a public HTTPS IP literal", async () => {
    // 8.8.8.8 is in no blocked CIDR; dns.lookup on a literal resolves to itself
    // without a network query, so this is deterministic.
    expect(await validateCloudBaseUrl("https://8.8.8.8/")).toBeNull();
  });

  it("bypasses IP blocking in dev mode but keeps format checks", async () => {
    process.env.ELIZA_DEV = "1";
    expect(await validateCloudBaseUrl("https://10.0.0.1/")).toBeNull();
    // Format checks still apply even in dev mode.
    expect(await validateCloudBaseUrl("http://10.0.0.1/")).toMatch(/must use HTTPS/);
  });
});
