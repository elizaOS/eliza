/**
 * Tests for cloud/validate-url.ts.
 */

import type { LookupAddress, LookupAllOptions } from "node:dns";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dnsMockState = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock("node:dns", () => {
  return {
    default: {
      lookup: dnsMockState.lookupMock,
    },
    lookup: dnsMockState.lookupMock,
  };
});

import { validateCloudBaseUrl } from "./validate-url.js";

function setLookupAddresses(addresses: string[]): void {
  dnsMockState.lookupMock.mockImplementation(
    (
      _hostname: string,
      _options: LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        addresses: LookupAddress[],
      ) => void,
    ) => {
      callback(
        null,
        addresses.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
      );
    },
  );
}

function setLookupError(code = "ENOTFOUND"): void {
  dnsMockState.lookupMock.mockImplementation(
    (
      _hostname: string,
      _options: LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        addresses: LookupAddress[],
      ) => void,
    ) => {
      const err = new Error("lookup failed") as NodeJS.ErrnoException;
      err.code = code;
      callback(err, []);
    },
  );
}

describe("validateCloudBaseUrl", () => {
  beforeEach(() => {
    dnsMockState.lookupMock.mockReset();
  });

  it("rejects malformed URLs", async () => {
    const result = await validateCloudBaseUrl("not a url");
    expect(result).toContain("Invalid cloud base URL");
  });

  it("requires https scheme", async () => {
    const result = await validateCloudBaseUrl("http://example.com");
    expect(result).toContain("must use HTTPS");
  });

  it("blocks direct link-local/metadata targets", async () => {
    const result = await validateCloudBaseUrl("https://169.254.169.254");
    expect(result).toContain("blocked");
    expect(dnsMockState.lookupMock).not.toHaveBeenCalled();
  });

  it("blocks IPv6 link-local targets across fe80::/10", async () => {
    const fe80 = await validateCloudBaseUrl("https://[fe80::1]");
    const fea0 = await validateCloudBaseUrl("https://[fea0::1]");
    const febf = await validateCloudBaseUrl("https://[febf::1]");

    expect(fe80).toContain("blocked");
    expect(fea0).toContain("blocked");
    expect(febf).toContain("blocked");
  });

  it("blocks additional special-use IPv4 ranges", async () => {
    const cgnat = await validateCloudBaseUrl("https://100.64.1.10");
    const benchmark = await validateCloudBaseUrl("https://198.18.0.5");
    const multicast = await validateCloudBaseUrl("https://239.1.2.3");

    expect(cgnat).toContain("blocked");
    expect(benchmark).toContain("blocked");
    expect(multicast).toContain("blocked");
  });

  it("blocks localhost-style hostnames before DNS resolution", async () => {
    const localhost = await validateCloudBaseUrl("https://localhost");
    const internalLocal = await validateCloudBaseUrl("https://api.local");

    expect(localhost).toContain("blocked local hostname");
    expect(internalLocal).toContain("blocked local hostname");
    expect(dnsMockState.lookupMock).not.toHaveBeenCalled();
  });

  it("blocks direct IPv6 ULA targets across fc00::/7", async () => {
    const fcResult = await validateCloudBaseUrl("https://[fc12::1]");
    const fdResult = await validateCloudBaseUrl("https://[fd12::1]");
    expect(fcResult).toContain("blocked");
    expect(fdResult).toContain("blocked");
  });

  it("blocks IPv6-mapped IPv4 loopback targets", async () => {
    const result = await validateCloudBaseUrl("https://[::ffff:7f00:1]");
    expect(result).toContain("blocked");
  });

  it("blocks IPv6 multicast and unspecified addresses", async () => {
    const multicast = await validateCloudBaseUrl("https://[ff02::1]");
    const unspecified = await validateCloudBaseUrl("https://[::]");
    expect(multicast).toContain("blocked");
    expect(unspecified).toContain("blocked");
  });

  it("blocks hostnames that resolve to blocked IPs", async () => {
    setLookupAddresses(["169.254.169.254"]);
    const result = await validateCloudBaseUrl("https://example.com");
    expect(result).toContain("blocked internal/metadata address");
  });

  it("allows hostnames that resolve to public IPs", async () => {
    setLookupAddresses(["93.184.216.34"]);
    const result = await validateCloudBaseUrl("https://example.com");
    expect(result).toBeNull();
  });

  it("fails closed when DNS resolution fails", async () => {
    setLookupError();
    const result = await validateCloudBaseUrl("https://example.com");
    expect(result).toContain("could not be resolved via DNS");
  });
});
