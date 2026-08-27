import { resetDevCloudEnvAuthorityForTests, resolveDevCloudEnvAuthority } from "@elizaos/shared";
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
let savedDevSource: string | undefined;
let savedDevCloudAuthority: string | undefined;
let savedCloudBaseUrl: string | undefined;
beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  savedNodeEnv = process.env.NODE_ENV;
  savedDev = process.env.ELIZA_DEV;
  savedDevSource = process.env.ELIZA_DEV_SOURCE;
  savedDevCloudAuthority = process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
  savedCloudBaseUrl = process.env.ELIZAOS_CLOUD_BASE_URL;
  // Ensure the IP-range blocking path is active (not the dev-mode bypass).
  process.env.NODE_ENV = "production";
  delete process.env.ELIZA_DEV;
  delete process.env.ELIZA_DEV_SOURCE;
  delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
  delete process.env.ELIZAOS_CLOUD_BASE_URL;
});
afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedDev === undefined) delete process.env.ELIZA_DEV;
  else process.env.ELIZA_DEV = savedDev;
  if (savedDevSource === undefined) delete process.env.ELIZA_DEV_SOURCE;
  else process.env.ELIZA_DEV_SOURCE = savedDevSource;
  if (savedDevCloudAuthority === undefined) {
    delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
  } else {
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = savedDevCloudAuthority;
  }
  if (savedCloudBaseUrl === undefined) {
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  } else {
    process.env.ELIZAOS_CLOUD_BASE_URL = savedCloudBaseUrl;
  }
  resetDevCloudEnvAuthorityForTests();
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

  it("allows only the frozen LAN HTTP endpoint for self-hosted authority", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "self-hosted";
    process.env.ELIZAOS_CLOUD_BASE_URL = "http://192.168.1.20:8787/api/v1";
    resolveDevCloudEnvAuthority();

    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

    expect(await validateCloudBaseUrl("http://192.168.1.20:8787/api/v1")).toBeNull();
    expect(await validateCloudBaseUrl("http://192.168.1.20:8787")).toBeNull();
    expect(await validateCloudBaseUrl("http://192.168.1.20:9999/api/v1")).toMatch(/does not match/);
    expect(await validateCloudBaseUrl("https://api.eliza.app/api/v1")).toMatch(/does not match/);
  });
});
